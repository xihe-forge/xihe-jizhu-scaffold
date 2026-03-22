import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  ensureDir,
  promptChoice,
  promptText,
  promptYesNo,
  readJson,
  rootDir,
  runCommand,
  slugify,
  withReadline,
  writeJson,
  writeText
} from "./lib/utils.mjs";
import { checkCircularDependencies } from "./lib/skill-utils.mjs";

const REGISTRY_PATH = ".ai/skills/skill-registry.json";
const SKILLS_DIR = ".ai/skills";

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

function getExistingModules(registry) {
  return Object.keys(registry.skills || {});
}

function getExistingSkillIds(registry) {
  const ids = [];
  for (const [moduleName, moduleData] of Object.entries(registry.skills || {})) {
    if (moduleData.skills) {
      for (const skillName of Object.keys(moduleData.skills)) {
        ids.push(`${moduleName}/${skillName}`);
      }
    }
  }
  return ids;
}

// --- Skill File Generation ---

function yamlEscape(value) {
  if (!value) return '""';
  // Quote if value contains YAML special characters
  if (/[:#\[\]{}&*!|>'"%@`,?-]/.test(value) || value.trim() !== value) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function generateSkillFile(metadata) {
  const lines = [
    "---",
    `name: ${yamlEscape(metadata.name)}`,
    `description: ${yamlEscape(metadata.description)}`
  ];

  if (metadata.role) {
    lines.push(`role: ${metadata.role}`);
  }
  if (metadata.depends_on) {
    lines.push(`depends_on: ${metadata.depends_on}`);
  }
  if (metadata.userInvokable) {
    lines.push(`user-invokable: true`);
  }

  lines.push("---", "");
  lines.push(`# ${metadata.displayName}`);
  lines.push("");
  lines.push("## When to Use");
  lines.push(metadata.when || "Describe when this skill should be invoked.");
  lines.push("");
  lines.push("## Instructions");
  lines.push("");
  lines.push("1. **Analyze** the target files and current state");
  lines.push("2. **Apply** the following checks:");
  lines.push("   - [ ] TODO: Define your checks here");
  lines.push("3. **Report** findings in structured format");
  lines.push("");
  lines.push("## Output Format");
  lines.push("");
  lines.push("### Findings");
  lines.push("| Severity | Category | Location | Description | Recommendation |");
  lines.push("|----------|----------|----------|-------------|----------------|");
  lines.push("| ... | ... | ... | ... | ... |");
  lines.push("");
  lines.push("## References");
  lines.push("- Add relevant documentation links");
  lines.push("");

  return lines.join("\n");
}

// --- Main ---

async function main() {
  const nameArg = process.argv[2];

  await withReadline(async (rl) => {
    // Get skill name
    const rawName = nameArg || await promptText(rl, "Skill name (kebab-case)");
    if (!rawName) {
      console.error("Error: Skill name is required.");
      process.exit(1);
    }
    const skillName = slugify(rawName);
    if (!skillName) {
      console.error(`Error: Skill name "${rawName}" produced an empty slug after sanitization. Use alphanumeric characters.`);
      process.exit(1);
    }

    console.log(`\nCreating skill: ${skillName}\n`);

    // Choose module: new or existing
    const registry = loadRegistry();
    const existingModules = getExistingModules(registry);

    let moduleName;
    let isNewModule = false;

    if (existingModules.length > 0) {
      const moduleChoices = [
        "Create a new module",
        ...existingModules.map((m) => `Add to existing: ${m}`)
      ];

      const moduleIndex = await promptChoice(rl, "Where should this skill live?", moduleChoices, 0);

      if (moduleIndex === 0) {
        isNewModule = true;
        const rawModuleName = await promptText(rl, "New module name (kebab-case)");
        moduleName = slugify(rawModuleName);
        if (!moduleName) {
          console.error(`Error: Module name "${rawModuleName}" produced an empty slug. Use alphanumeric characters.`);
          process.exit(1);
        }
      } else {
        moduleName = existingModules[moduleIndex - 1];
      }
    } else {
      isNewModule = true;
      const rawModuleName = await promptText(rl, "Module name (kebab-case)");
      moduleName = slugify(rawModuleName);
      if (!moduleName) {
        console.error(`Error: Module name "${rawModuleName}" produced an empty slug. Use alphanumeric characters.`);
        process.exit(1);
      }
    }

    const modulePath = `${SKILLS_DIR}/${moduleName}`;
    const absoluteModulePath = path.join(rootDir, modulePath);

    // Create module directory if new
    if (isNewModule && !existsSync(absoluteModulePath)) {
      mkdirSync(absoluteModulePath, { recursive: true });
      console.log(`Created module directory: ${modulePath}`);
    }

    // Gather skill metadata
    console.log("\n--- Skill Metadata ---\n");

    const displayName = await promptText(rl, "Display name", skillName.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
    const description = await promptText(rl, "Description");

    const roleChoices = [
      "design_generator",
      "design_audit",
      "engineering_review",
      "seo_audit",
      "security_audit",
      "performance",
      "code_quality",
      "testing",
      "documentation",
      "custom (enter manually)"
    ];
    const roleIndex = await promptChoice(rl, "\nRole:", roleChoices, 2);
    let role;
    if (roleIndex === roleChoices.length - 1) {
      role = await promptText(rl, "Custom role");
    } else {
      role = roleChoices[roleIndex];
    }

    const when = await promptText(rl, "When should this skill be used?");

    // Dependencies
    const existingSkillIds = getExistingSkillIds(registry);
    let dependsOn = null;

    if (existingSkillIds.length > 0) {
      const hasDeps = await promptYesNo(rl, "Does this skill depend on another skill?", false);
      if (hasDeps) {
        const depChoices = existingSkillIds;
        const depIndex = await promptChoice(rl, "Select dependency:", depChoices, 0);
        dependsOn = depChoices[depIndex];
      }
    }

    const userInvokable = await promptYesNo(rl, "User-invokable (can be called directly)?", false);

    // Determine skill file path within the module
    const skillDir = path.join(absoluteModulePath, "skills", skillName);
    const skillFilePath = path.join(skillDir, "SKILL.md");
    const relativeSkillFile = path.relative(absoluteModulePath, skillFilePath).replace(/\\/g, "/");

    // Generate the skill file
    const metadata = {
      name: skillName,
      displayName,
      description,
      role,
      when,
      depends_on: dependsOn,
      userInvokable
    };

    ensureDir(path.relative(rootDir, skillDir));
    writeText(path.relative(rootDir, skillFilePath), generateSkillFile(metadata));
    console.log(`\nCreated: ${path.relative(rootDir, skillFilePath)}`);

    // Register in skill-registry.json
    console.log("\n--- Registry Configuration ---\n");

    // Phase selection
    const phaseChoices = [
      "implement (design/code generation)",
      "review (code review and audits)",
      "final_review (pre-merge quality gate)",
      "deploy (post-deploy checks)",
      "custom (enter manually)"
    ];

    const phaseIndex = await promptChoice(rl, "Which phases should trigger this skill?", phaseChoices, 1);
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
    const tagsInput = await promptText(rl, "Task tags (comma-separated)", "general");
    const taskTags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);

    // File patterns
    const patternsInput = await promptText(rl, "File patterns (comma-separated)", "*.tsx, *.jsx, *.ts, *.js");
    const filePatterns = patternsInput.split(",").map((p) => p.trim()).filter(Boolean);

    // Build or update the module entry
    const skillId = `${moduleName}/${skillName}`;

    if (isNewModule || !registry.skills[moduleName]) {
      // New module entry
      registry.skills[moduleName] = {
        version: "1.0.0",
        description: `Skills from ${moduleName}`,
        source: "",
        license: "MIT",
        path: modulePath,
        trigger: {
          phase: selectedPhases,
          task_tags: taskTags,
          file_patterns: filePatterns
        },
        skills: {}
      };
    }

    // Add the skill to the module
    const skillEntry = {
      file: relativeSkillFile,
      role,
      when: when || description
    };
    if (dependsOn) {
      skillEntry.depends_on = dependsOn;
    }
    registry.skills[moduleName].skills[skillName] = skillEntry;

    // Update execution_order
    for (const phase of selectedPhases) {
      const existingKeys = Object.keys(registry.execution_order).filter((k) => k.startsWith(phase));

      if (existingKeys.length > 0) {
        const key = existingKeys[0];
        const existing = registry.execution_order[key] || [];
        if (!existing.includes(skillId)) {
          existing.push(skillId);
          registry.execution_order[key] = existing;
        }
        console.log(`Added to execution_order.${key}`);
      } else {
        const suffix = taskTags[0] || "general";
        const key = `${phase}_${suffix}`;
        registry.execution_order[key] = [skillId];
        console.log(`Created execution_order.${key}`);
      }
    }

    // Update phase_mapping
    for (const phase of selectedPhases) {
      const existingKeys = Object.keys(registry.phase_mapping || {}).filter((k) => k.startsWith(phase));

      if (existingKeys.length > 0) {
        const key = existingKeys[0];
        const mapping = registry.phase_mapping[key] || {};
        const existing = mapping[role] || [];
        if (!existing.includes(skillId)) {
          existing.push(skillId);
        }
        mapping[role] = existing;
        registry.phase_mapping[key] = mapping;
      } else {
        const suffix = taskTags[0] || "general";
        const key = `${phase}_${suffix}`;
        registry.phase_mapping = registry.phase_mapping || {};
        registry.phase_mapping[key] = { [role]: [skillId] };
      }
    }

    // Validate
    const cycles = checkCircularDependencies(registry);
    if (cycles.length > 0) {
      console.warn(`\nWarning: Potential circular dependencies detected in: ${cycles.join(", ")}`);
    }

    // Write registry
    writeJson(REGISTRY_PATH, registry);
    console.log(`\nUpdated ${REGISTRY_PATH}`);

    // Summary
    console.log("\n--- Summary ---\n");
    console.log(`Skill: ${skillId}`);
    console.log(`File: ${path.relative(rootDir, skillFilePath)}`);
    console.log(`Role: ${role}`);
    console.log(`Phases: ${selectedPhases.join(", ")}`);
    console.log(`Tags: ${taskTags.join(", ")}`);
    console.log(`Patterns: ${filePatterns.join(", ")}`);

    console.log("\n--- Next Steps ---\n");
    console.log(`1. Edit ${path.relative(rootDir, skillFilePath)} to add your actual instructions`);
    console.log("2. Define specific checks in the Instructions section");
    console.log("3. Add reference documentation links");
    if (isNewModule) {
      console.log(`4. Consider initializing ${modulePath} as a git repo if sharing externally`);
    }

    // Optional git commit
    const shouldCommit = await promptYesNo(rl, "\nGit add and commit changes?", false);
    if (shouldCommit) {
      runCommand("git", ["add", path.relative(rootDir, skillFilePath), REGISTRY_PATH]);
      runCommand("git", ["commit", "-m", `feat: create skill ${skillId}`]);
      console.log("Changes committed.");
    }
  });
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
