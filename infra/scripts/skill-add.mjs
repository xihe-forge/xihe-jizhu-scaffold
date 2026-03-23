import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  promptChoice,
  promptText,
  promptYesNo,
  readJson,
  rootDir,
  runCommand,
  slugify,
  withReadline,
  writeJson
} from "./lib/utils.mjs";
import { checkCircularDependencies } from "./lib/skill-utils.mjs";

const REGISTRY_PATH = ".ai/skills/skill-registry.json";
const SKILLS_DIR = ".ai/skills";

// --- URL Parsing ---

function parseGitHubUrl(url) {
  // Support HTTPS: https://github.com/org/repo.git or https://github.com/org/repo
  // Support SSH: git@github.com:org/repo.git or git@github.com:org/repo
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { org: httpsMatch[1], repo: httpsMatch[2], url };
  }

  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { org: sshMatch[1], repo: sshMatch[2], url };
  }

  return null;
}

// --- SKILL.md Scanning ---

function findSkillFiles(dirPath) {
  const results = [];

  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        walk(fullPath);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(fullPath);
      }
    }
  }

  walk(dirPath);
  return results;
}

function parseYamlFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }

  const yaml = match[1];
  const result = {};

  for (const line of yaml.split("\n")) {
    const kvMatch = line.match(/^(\w[\w_-]*):\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let value = kvMatch[2].trim();
      // Strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function scanSkills(modulePath, moduleName) {
  const skillFiles = findSkillFiles(modulePath);
  const skills = [];

  for (const filePath of skillFiles) {
    const relativePath = path.relative(modulePath, filePath).replace(/\\/g, "/");
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      console.warn(`  Warning: Could not read ${relativePath}, skipping.`);
      continue;
    }

    const frontmatter = parseYamlFrontmatter(content);
    if (!frontmatter) {
      console.warn(`  Warning: No valid frontmatter in ${relativePath}, skipping.`);
      continue;
    }

    // Derive skill name from directory structure
    const dirName = path.dirname(relativePath).replace(/\\/g, "/");
    const dirPart = dirName.split("/").pop();
    const skillName = frontmatter.name || (dirPart && dirPart !== "." ? dirPart : moduleName);

    skills.push({
      name: skillName,
      file: relativePath,
      role: frontmatter.role || "general",
      when: frontmatter.when || frontmatter.description || "",
      description: frontmatter.description || "",
      depends_on: frontmatter.depends_on || null,
      "user-invokable": frontmatter["user-invokable"] === "true" || frontmatter["user-invokable"] === true
    });
  }

  return skills;
}

// --- Registry Operations ---

function loadRegistry() {
  return readJson(REGISTRY_PATH, {
    version: "1.0.0",
    description: "External skill modules registry. Autopilot uses this to determine which skills to invoke at each phase.",
    execution_order: {},
    skills: {},
    phase_mapping: {}
  });
}

// --- Exports for testing ---

export { parseGitHubUrl, parseYamlFrontmatter, checkCircularDependencies };
// --- Main ---

async function main() {
  const urlArg = process.argv[2];
  if (!urlArg) {
    console.error("Usage: pnpm skill:add <github-url>");
    console.error("");
    console.error("Examples:");
    console.error("  pnpm skill:add https://github.com/org/repo.git");
    console.error("  pnpm skill:add git@github.com:org/repo.git");
    process.exit(1);
  }

  const parsed = parseGitHubUrl(urlArg);
  if (!parsed) {
    console.error(`Error: Could not parse GitHub URL: ${urlArg}`);
    console.error("Supported formats:");
    console.error("  https://github.com/org/repo.git");
    console.error("  git@github.com:org/repo.git");
    process.exit(1);
  }

  const moduleName = slugify(parsed.repo);
  if (!moduleName) {
    console.error(`Error: Repository name "${parsed.repo}" produced an empty module name after sanitization.`);
    process.exit(1);
  }
  const submodulePath = `${SKILLS_DIR}/${moduleName}`;
  const absoluteSubmodulePath = path.join(rootDir, submodulePath);

  console.log(`\nSkill Module: ${moduleName}`);
  console.log(`Source: ${parsed.url}`);
  console.log(`Path: ${submodulePath}\n`);

  // Check if module already exists in registry
  const registry = loadRegistry();
  if (registry.skills[moduleName]) {
    console.log(`Module "${moduleName}" already exists in skill-registry.json.`);
    const shouldUpdate = await withReadline(async (rl) => {
      return promptYesNo(rl, "Update the existing module instead?", true);
    });
    if (!shouldUpdate) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  // Add or update git submodule
  if (existsSync(absoluteSubmodulePath) && existsSync(path.join(absoluteSubmodulePath, ".git"))) {
    console.log("Submodule directory already exists. Updating...");
    const updateResult = runCommand("git", ["submodule", "update", "--remote", "--merge", submodulePath]);
    if (updateResult.status !== 0) {
      console.error("Warning: git submodule update failed. Continuing with existing content.");
    }
  } else {
    console.log("Adding git submodule...");
    const addResult = runCommand("git", ["submodule", "add", parsed.url, submodulePath]);
    if (addResult.status !== 0) {
      console.error("Error: git submodule add failed.");
      process.exit(1);
    }

    console.log("Initializing submodule...");
    const initResult = runCommand("git", ["submodule", "update", "--init", submodulePath]);
    if (initResult.status !== 0) {
      console.error("Warning: git submodule init failed. The submodule may need manual initialization.");
    }
  }

  // Scan for SKILL.md files
  console.log("\nScanning for skills...");
  const discoveredSkills = scanSkills(absoluteSubmodulePath, moduleName);

  if (discoveredSkills.length === 0) {
    console.warn("\nWarning: No SKILL.md files found in the submodule.");
    console.warn("You can manually configure skills in skill-registry.json later.");
  } else {
    console.log(`\nDiscovered ${discoveredSkills.length} skill(s):`);
    for (const skill of discoveredSkills) {
      console.log(`  - ${skill.name} (${skill.role}): ${skill.when || skill.description}`);
    }
  }

  // Read package.json and README from submodule
  const submodulePkg = readJson(path.join(submodulePath, "package.json"), null);
  let submoduleReadme = "";
  try {
    submoduleReadme = readFileSync(path.join(absoluteSubmodulePath, "README.md"), "utf8");
  } catch {
    // No README
  }

  const moduleVersion = submodulePkg?.version || "1.0.0";
  const moduleLicense = submodulePkg?.license || "MIT";
  const moduleDescription = submodulePkg?.description
    || (submoduleReadme ? submoduleReadme.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() : "")
    || `Skills from ${moduleName}`;

  // Interactive configuration
  await withReadline(async (rl) => {
    console.log("\n--- Configuration ---\n");

    // Confirm skills
    if (discoveredSkills.length > 0) {
      const confirmSkills = await promptYesNo(rl, "Use discovered skills as listed above?", true);
      if (!confirmSkills) {
        console.log("You can edit skill-registry.json manually after this script completes.");
      }
    }

    // Phase selection
    const phaseChoices = [
      "implement (design/code generation)",
      "review (code review and audits)",
      "final_review (pre-merge quality gate)",
      "deploy (post-deploy checks)",
      "custom (enter manually)"
    ];

    const phaseIndex = await promptChoice(rl, "\nWhich phases should trigger this module?", phaseChoices, 1);
    let selectedPhases;
    if (phaseIndex === 4) {
      const custom = await promptText(rl, "Enter phases (comma-separated)", "review");
      selectedPhases = custom.split(",").map((p) => p.trim()).filter(Boolean);
    } else {
      const phaseMap = ["implement", "review", "final_review", "deploy"];
      selectedPhases = [phaseMap[phaseIndex]];

      const addMore = await promptYesNo(rl, "Add additional phases?", false);
      if (addMore) {
        const extra = await promptText(rl, "Additional phases (comma-separated)");
        if (extra) {
          selectedPhases.push(...extra.split(",").map((p) => p.trim()).filter(Boolean));
        }
      }
    }

    // Task tags
    const suggestedTags = [...new Set(discoveredSkills.flatMap((s) => {
      const tags = [];
      const text = `${s.role} ${s.when} ${s.description}`.toLowerCase();
      if (text.includes("frontend") || text.includes("ui") || text.includes("design")) tags.push("frontend", "ui", "design");
      if (text.includes("seo")) tags.push("seo");
      if (text.includes("test")) tags.push("testing");
      if (text.includes("security")) tags.push("security");
      if (text.includes("performance")) tags.push("performance");
      if (text.includes("api")) tags.push("api", "backend");
      return tags;
    }))];

    const defaultTags = suggestedTags.length > 0 ? suggestedTags.join(", ") : "general";
    const tagsInput = await promptText(rl, `Task tags (comma-separated)`, defaultTags);
    const taskTags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);

    // File patterns
    const defaultPatterns = "*.tsx, *.jsx, *.ts, *.js";
    const patternsInput = await promptText(rl, "File patterns (comma-separated)", defaultPatterns);
    const filePatterns = patternsInput.split(",").map((p) => p.trim()).filter(Boolean);

    // Build registry entry
    const skillsEntry = {};
    for (const skill of discoveredSkills) {
      const entry = {
        file: skill.file,
        role: skill.role,
        when: skill.when || skill.description
      };
      if (skill.depends_on) {
        entry.depends_on = skill.depends_on;
      }
      skillsEntry[skill.name] = entry;
    }

    const moduleEntry = {
      version: moduleVersion,
      description: moduleDescription,
      source: parsed.url,
      license: moduleLicense,
      path: submodulePath,
      trigger: {
        phase: selectedPhases,
        task_tags: taskTags,
        file_patterns: filePatterns
      },
      skills: skillsEntry
    };

    // Merge into registry
    registry.skills[moduleName] = moduleEntry;

    // Update execution_order for chosen phases
    const skillIds = discoveredSkills.map((s) => `${moduleName}/${s.name}`);

    for (const phase of selectedPhases) {
      // Determine execution_order key (e.g., "review_frontend" or just the phase)
      // Look for existing keys that start with this phase, or create a new one
      const existingKeys = Object.keys(registry.execution_order).filter((k) => k.startsWith(phase));

      if (existingKeys.length > 0) {
        // Add to the first matching phase key
        const key = existingKeys[0];
        const existing = registry.execution_order[key] || [];
        const merged = [...new Set([...existing, ...skillIds])];
        registry.execution_order[key] = merged;
        console.log(`\nAdded to execution_order.${key}`);
      } else {
        // Create a new execution_order entry
        const suffix = taskTags[0] || "general";
        const key = `${phase}_${suffix}`;
        registry.execution_order[key] = skillIds;
        console.log(`\nCreated execution_order.${key}`);
      }
    }

    // Update phase_mapping
    for (const phase of selectedPhases) {
      const existingKeys = Object.keys(registry.phase_mapping || {}).filter((k) => k.startsWith(phase));

      if (existingKeys.length > 0) {
        const key = existingKeys[0];
        const mapping = registry.phase_mapping[key] || {};
        const category = discoveredSkills[0]?.role || "general";
        const existing = mapping[category] || [];
        mapping[category] = [...new Set([...existing, ...skillIds])];
        registry.phase_mapping[key] = mapping;
      } else {
        const suffix = taskTags[0] || "general";
        const key = `${phase}_${suffix}`;
        const category = discoveredSkills[0]?.role || "general";
        registry.phase_mapping = registry.phase_mapping || {};
        registry.phase_mapping[key] = { [category]: skillIds };
      }
    }

    // Validate: check for circular dependencies
    const cycles = checkCircularDependencies(registry);
    if (cycles.length > 0) {
      console.warn(`\nWarning: Potential circular dependencies detected in: ${cycles.join(", ")}`);
      console.warn("Please review the depends_on fields in skill-registry.json.");
    }

    // Write registry
    writeJson(REGISTRY_PATH, registry);
    console.log(`\nUpdated ${REGISTRY_PATH}`);

    // Summary
    console.log("\n--- Summary ---\n");
    console.log(`Module: ${moduleName}`);
    console.log(`Skills: ${discoveredSkills.map((s) => s.name).join(", ") || "(none)"}`);
    console.log(`Phases: ${selectedPhases.join(", ")}`);
    console.log(`Tags: ${taskTags.join(", ")}`);
    console.log(`Patterns: ${filePatterns.join(", ")}`);

    // Optional git commit
    const shouldCommit = await promptYesNo(rl, "\nGit add and commit changes?", false);
    if (shouldCommit) {
      runCommand("git", ["add", submodulePath, REGISTRY_PATH, ".gitmodules"]);
      runCommand("git", ["commit", "-m", `feat: add skill module ${moduleName}`]);
      console.log("Changes committed.");
    } else {
      console.log("\nRemember to commit changes when ready:");
      console.log(`  git add ${submodulePath} ${REGISTRY_PATH} .gitmodules`);
      console.log(`  git commit -m "feat: add skill module ${moduleName}"`);
    }
  });
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isDirectRun) {
  main().catch((err) => {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  });
}
