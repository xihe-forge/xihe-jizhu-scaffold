import {
  configureAutopilotWithReadline,
  loadAutopilotConfig,
  renderRunnerSummary,
  saveAutopilotConfig
} from "./lib/autopilot-runner.mjs";
import { runTextPrompt } from "./lib/ai-runner.mjs";
import {
  appendProgressEntry,
  normalizeProjectPlan,
  writeProjectPlan
} from "./lib/project-setup.mjs";
import {
  ensureDir,
  formatDuration,
  pathExists,
  promptText,
  promptYesNo,
  readJson,
  readText,
  runCommand,
  sleep,
  withReadline,
  writeJson,
  writeText
} from "./lib/utils.mjs";

// ---------------------------------------------------------------------------
// Project scanning
// ---------------------------------------------------------------------------

function scanExistingProject() {
  const pkg = readJson("package.json", null);
  const name = pkg?.name ?? null;
  const description = pkg?.description ?? "";
  const isMonorepo = pathExists("pnpm-workspace.yaml") || pathExists("lerna.json") || pathExists("nx.json");

  const directoryNames = ["src", "apps", "lib", "packages", "services", "api", "web", "server", "client"];
  const directories = directoryNames.filter((dir) => pathExists(dir));

  const readme = pathExists("README.md") ? readText("README.md").slice(0, 800).trim() : "";

  return {
    name,
    description,
    hasMonorepo: isMonorepo,
    directories,
    readme
  };
}

// ---------------------------------------------------------------------------
// AI prompt
// ---------------------------------------------------------------------------

function buildAdoptPrompt({ projectDescription, workGoal, currentStatus, scan }) {
  const scanSummary = [
    scan.name ? `Package name: ${scan.name}` : "No package.json found",
    scan.description ? `Package description: ${scan.description}` : "",
    scan.hasMonorepo ? "This is a monorepo (pnpm-workspace.yaml or similar)." : "",
    scan.directories.length > 0 ? `Detected directories: ${scan.directories.join(", ")}` : "",
    scan.readme ? `README excerpt:\n${scan.readme}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "You are helping a developer add an AI planning layer to an existing codebase.",
    "Read the project context below and generate a structured project plan in valid JSON.",
    "Return only valid JSON. No markdown. No code fences.",
    "Generate 3 to 6 focused tasks that continue the current work naturally.",
    "",
    "Return this JSON shape exactly:",
    '{',
    '  "projectName": "kebab-case name",',
    '  "scope": "@scope",',
    '  "description": "short repo description",',
    '  "positioning": "one-line positioning",',
    '  "currentAssumption": "current assumption about the project",',
    '  "targetUsers": ["user segment"],',
    '  "desiredOutcome": "desired outcome",',
    '  "requirements": {',
    '    "inScope": ["item"],',
    '    "outOfScope": ["item"],',
    '    "notes": ["item"]',
    "  },",
    '  "roadmap": {',
    '    "milestoneName": "Milestone 1: ...",',
    '    "milestoneGoal": "goal",',
    '    "phases": [',
    '      { "name": "Phase 1", "items": ["item"] }',
    "    ]",
    "  },",
    '  "state": {',
    '    "currentStatus": "status",',
    '    "activeFocus": "focus",',
    '    "nextStep": "next step",',
    '    "openDecisions": ["item"]',
    "  },",
    '  "tasks": [',
    '    {',
    '      "id": "T001",',
    '      "phase": "Phase 1: Name",',
    '      "type": "planning|research|docs|backend|frontend|testing|review",',
    '      "name": "task name",',
    '      "description": "task description",',
    '      "priority": "P0|P1|P2",',
    '      "status": "todo",',
    '      "assignee": "owner",',
    '      "depends_on": [],',
    '      "acceptance_criteria": ["item"]',
    "    }",
    "  ],",
    '  "progressEntry": "first progress log entry summarising adoption"',
    '}',
    "",
    "--- Project scan ---",
    scanSummary,
    "",
    "--- User answers ---",
    `What this project does: ${projectDescription}`,
    `What the user wants AI to work on next: ${workGoal}`,
    `Current project status (what's done, what's next): ${currentStatus}`
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Plan summary rendering
// ---------------------------------------------------------------------------

function renderPlanSummary(plan) {
  return [
    "",
    "Adoption plan ready",
    "===================",
    `Name: ${plan.projectName}`,
    `Scope: ${plan.scope}`,
    `Positioning: ${plan.positioning}`,
    `Milestone: ${plan.roadmap.milestoneName}`,
    `Tasks: ${plan.tasks.length}`,
    `Next step: ${plan.state.nextStep}`,
    ""
  ].join("\n");
}

// ---------------------------------------------------------------------------
// File writing (additive only)
// ---------------------------------------------------------------------------

function writeAdoptionTranscript({ projectDescription, workGoal, currentStatus, scan, plan }) {
  ensureDir("docs/intake");
  const content = [
    "# Project Adoption",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Project Scan",
    "",
    scan.name ? `- Package name: ${scan.name}` : "",
    scan.description ? `- Description: ${scan.description}` : "",
    `- Directories found: ${scan.directories.join(", ") || "none"}`,
    scan.hasMonorepo ? "- Monorepo: yes" : "",
    "",
    "## User Input",
    "",
    `**What this project does:** ${projectDescription}`,
    "",
    `**AI work goal:** ${workGoal}`,
    "",
    `**Current status:** ${currentStatus}`,
    "",
    "## Result Summary",
    "",
    `- Project: ${plan.projectName}`,
    `- Positioning: ${plan.positioning}`,
    `- Milestone: ${plan.roadmap.milestoneName}`,
    `- Tasks generated: ${plan.tasks.length}`
  ]
    .filter((line) => line !== null)
    .join("\n");

  writeText("docs/intake/PROJECT-INTAKE.md", content);
}

function writeAdoptionFiles(plan, { projectDescription, workGoal, currentStatus, scan }) {
  ensureDir(".planning");

  const files = {
    ".planning/PROJECT.md": true,
    ".planning/REQUIREMENTS.md": true,
    ".planning/ROADMAP.md": true,
    ".planning/STATE.md": true,
    "dev/task.json": true,
    "AGENTS.md": false
  };

  const existingFiles = Object.keys(files).filter((f) => pathExists(f));
  const missingFiles = Object.keys(files).filter((f) => !pathExists(f));

  if (existingFiles.length > 0) {
    console.log("");
    console.log(`[adopt] Skipping files that already exist: ${existingFiles.join(", ")}`);
  }

  if (missingFiles.length > 0) {
    console.log(`[adopt] Writing new files: ${missingFiles.join(", ")}`);
    writeProjectPlan(plan);
  } else {
    console.log("[adopt] All planning files already exist — skipping writeProjectPlan.");
  }

  // Always append progress (never overwrite)
  appendProgressEntry(plan.progressEntry);

  // Write adoption transcript (overwrite is fine — it's a generated artefact)
  writeAdoptionTranscript({ projectDescription, workGoal, currentStatus, scan, plan });

  // Write AGENTS.md only if it doesn't exist
  if (!pathExists("AGENTS.md")) {
    const scaffoldAgentsMd = readText("AGENTS.md");
    if (scaffoldAgentsMd) {
      writeText("AGENTS.md", scaffoldAgentsMd);
      console.log("[adopt] AGENTS.md created.");
    }
  }

  console.log("");
  console.log("Planning files written.");
}

// ---------------------------------------------------------------------------
// AI call with simple retry
// ---------------------------------------------------------------------------

function detectFailureCategory(text) {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    normalized.includes("rate limit") ||
    normalized.includes("quota") ||
    normalized.includes("usage limit") ||
    normalized.includes("hit your limit") ||
    normalized.includes("hit the limit") ||
    normalized.includes("credit balance") ||
    normalized.includes("429") ||
    normalized.includes("too many requests")
  ) {
    return "quota";
  }

  return "runner";
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`AI did not return a JSON object.\n\nRaw output:\n${text}`);
  }

  return JSON.parse(text.slice(start, end + 1));
}

async function runPromptWithSimpleRetry({ config, model, prompt, label, maxRetries = 3, waitSeconds = 15 }) {
  let attempt = 0;

  while (true) {
    attempt += 1;
    const result = await runTextPrompt({ config, model, prompt });
    if (result.exitCode === 0) {
      return result;
    }

    const detail = [result.stderr, result.error, result.stdout].filter(Boolean).join("\n").trim();
    const failureCategory = detectFailureCategory(detail);
    const isQuota = failureCategory === "quota";

    if (!isQuota && attempt >= maxRetries) {
      throw new Error(
        `${label} failed after ${maxRetries} attempts.` + (detail ? `\n${detail}` : "")
      );
    }

    console.log("");
    console.log(
      `[retry] ${label} failed on attempt ${attempt}. ` +
        `${isQuota ? "Quota/rate limit detected" : "AI runner error"}. ` +
        `Waiting ${formatDuration(waitSeconds)} before retrying...`
    );
    if (detail) {
      console.log(`[retry] detail: ${detail.split(/\r?\n/u)[0]}`);
    }
    await sleep(waitSeconds * 1000);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = loadAutopilotConfig({ persist: true });

  const session = await withReadline(async (rl) => {
    console.log("");
    console.log("Adopt Existing Project");
    console.log("======================");
    console.log("");

    // Step 1: Check for existing .planning/STATE.md
    if (pathExists(".planning/STATE.md")) {
      console.log("[adopt] This project already has a .planning/STATE.md file.");
      const proceed = await promptYesNo(
        rl,
        "Planning state already exists. Re-initialize (additive — existing files will be skipped)",
        false
      );
      if (!proceed) {
        console.log("[adopt] Adoption cancelled.");
        process.exit(0);
      }
    }

    // Step 2: Scan project
    console.log("[adopt] Scanning project structure...");
    const scan = scanExistingProject();

    if (scan.name) {
      console.log(`[adopt] Detected package: ${scan.name}`);
    }
    if (scan.directories.length > 0) {
      console.log(`[adopt] Found directories: ${scan.directories.join(", ")}`);
    }
    if (scan.hasMonorepo) {
      console.log("[adopt] Monorepo detected.");
    }

    // Step 3: Interview
    console.log("");
    const projectDescription = await promptText(
      rl,
      "Describe what this project does",
      scan.description || ""
    );

    const workGoal = await promptText(
      rl,
      "What do you want AI to work on next",
      ""
    );

    const currentStatus = await promptText(
      rl,
      "What's the current project status? (what's done, what's next)",
      ""
    );

    // Step 4: Configure runtime
    console.log("");
    console.log(`Current AI runtime: ${renderRunnerSummary(config)}`);
    const keepCurrent = await promptYesNo(
      rl,
      "Use this runtime for planning and 7x24 work",
      true
    );
    const configured = keepCurrent
      ? config
      : await (async () => {
          console.log("");
          return configureAutopilotWithReadline(rl, config);
        })();

    saveAutopilotConfig(configured);

    // Step 5: Call AI
    console.log("");
    console.log("AI is generating an adoption plan...");
    const planResponse = await runPromptWithSimpleRetry({
      config: configured,
      model: configured.models.planning,
      prompt: buildAdoptPrompt({ projectDescription, workGoal, currentStatus, scan }),
      label: "AI adoption planning",
      maxRetries: 3,
      waitSeconds: 15
    });

    const plan = normalizeProjectPlan(extractJsonObject(planResponse.stdout));

    // Step 6: Show summary and get approval
    console.log(renderPlanSummary(plan));
    const approved = await promptYesNo(rl, "Write this plan into the repository", true);

    if (!approved) {
      console.log("[adopt] Adoption cancelled. No files written.");
      process.exit(0);
    }

    // Step 7: Write files
    writeAdoptionFiles(plan, { projectDescription, workGoal, currentStatus, scan });

    // Step 8: Health check
    const runHealth = await promptYesNo(rl, "Run health check now", true);

    // Step 9: Offer autopilot start
    const startAutopilot = await promptYesNo(rl, "Start 7x24 autopilot now", false);

    return { configured, runHealth, startAutopilot };
  });

  // Post-readline: run health check
  if (session.runHealth) {
    console.log("");
    const healthResult = runCommand("pnpm", ["health"]);
    if (healthResult.status !== 0) {
      console.log("[adopt] Health check reported issues. Review above before starting autopilot.");
    }
  }

  // Post-readline: start autopilot
  if (session.startAutopilot) {
    const doctorResult = runCommand("pnpm", ["autopilot:doctor"]);
    if (doctorResult.status !== 0) {
      process.exit(doctorResult.status ?? 1);
    }

    const workResult = runCommand("node", ["infra/scripts/autopilot-start.mjs"]);
    if (workResult.status !== 0) {
      process.exit(workResult.status ?? 1);
    }
  } else {
    console.log("");
    console.log("Adoption complete. Run `pnpm work` when you want the AI to start 7x24.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
