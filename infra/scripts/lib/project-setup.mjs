import { existsSync } from "node:fs";
import { readJson, readText, replaceMarkdownSection, resolvePath, slugify, writeJson, writeText } from "./utils.mjs";

export function detectCurrentRootName() {
  return readJson("package.json", {})?.name ?? "robust-ai-scaffold";
}

export function detectCurrentScope() {
  const sharedPackage = readJson("packages/shared/package.json", {});
  const dependencyNames = Object.keys(sharedPackage.dependencies ?? {});
  const typeDependency = dependencyNames.find((name) => name.endsWith("/types"));

  if (!typeDependency) {
    return `@${detectCurrentRootName()}`;
  }

  return typeDependency.replace(/\/types$/, "");
}

export function readCurrentPositioning() {
  const projectMarkdown = readText(".planning/PROJECT.md");
  const match = projectMarkdown.match(/## One-line Positioning\s+([\s\S]*?)(?=\n## |\s*$)/m);
  return match?.[1]?.trim() || "One-line product positioning";
}

function applyReplacements(replacements, relativePaths) {
  for (const relativePath of relativePaths) {
    if (!existsSync(resolvePath(relativePath))) {
      continue;
    }
    let content = readText(relativePath);
    for (const [from, to] of replacements) {
      if (!from || from === to) {
        continue;
      }
      content = content.split(from).join(to);
    }
    writeText(relativePath, content);
  }
}

export function initializeProjectIdentity({ projectName, scope, description, positioning }) {
  const currentRootName = detectCurrentRootName();
  const currentScope = detectCurrentScope();

  const replacements = [
    [currentScope, scope],
    ["@robust-ai-scaffold", scope],
    [currentRootName, projectName],
    ["robust-ai-scaffold", projectName],
    ["Resilient monorepo scaffold with durable planning state", description]
  ];

  const targetFiles = [
    "package.json",
    ".env.example",
    ".planning/PROJECT.md",
    ".planning/REQUIREMENTS.md",
    ".planning/ROADMAP.md",
    ".planning/STATE.md",
    "dev/task.json",
    "apps/web/package.json",
    "apps/web/src/main.ts",
    "apps/api/package.json",
    "apps/api/src/main.ts",
    "packages/shared/package.json",
    "packages/shared/src/index.ts",
    "packages/types/package.json",
    "AGENTS.md",
    "TEMPLATE-USAGE.md",
    ".ai/recipes/create-project.md",
    ".codex/skills/create-project-from-scaffold/SKILL.md"
  ];

  applyReplacements(replacements, targetFiles);

  const envExample = readText(".env.example").replace(/APP_NAME=.*/u, `APP_NAME=${projectName}`);
  writeText(".env.example", envExample);

  const projectMarkdown = replaceMarkdownSection(
    readText(".planning/PROJECT.md"),
    "One-line Positioning",
    positioning
  );
  const projectMarkdownWithAssumption = replaceMarkdownSection(
    projectMarkdown,
    "Current Assumption",
    `This repository is initialized for ${projectName} and should now be adapted to its business domain.`
  );
  writeText(".planning/PROJECT.md", projectMarkdownWithAssumption);

  const stateMarkdown = replaceMarkdownSection(
    readText(".planning/STATE.md"),
    "Next Step",
    `Project identity initialized for ${projectName}. Next choose the actual application stack.`
  );
  writeText(".planning/STATE.md", stateMarkdown);

  let readme = readText("README.md");
  for (const [from, to] of replacements) {
    if (!from || from === to) continue;
    readme = readme.split(from).join(to);
  }
  readme = readme.replace(
    "A resilient project scaffold that blends:",
    `${description}\n\nThis project currently blends:`
  );
  writeText("README.md", readme);
}

function renderList(items = [], emptyLine = "- none yet") {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : emptyLine;
}

export function renderProjectMarkdown(plan) {
  return [
    "# Project",
    "",
    "## Name",
    "",
    plan.projectName,
    "",
    "## One-line Positioning",
    "",
    plan.positioning,
    "",
    "## Current Assumption",
    "",
    plan.currentAssumption,
    "",
    "## Target Users",
    "",
    renderList(plan.targetUsers),
    "",
    "## Desired Outcome",
    "",
    plan.desiredOutcome
  ].join("\n");
}

export function renderRequirementsMarkdown(plan) {
  return [
    "# Requirements",
    "",
    "## In Scope",
    "",
    renderList(plan.requirements.inScope),
    "",
    "## Out of Scope",
    "",
    renderList(plan.requirements.outOfScope),
    "",
    "## Notes",
    "",
    renderList(plan.requirements.notes)
  ].join("\n");
}

export function renderRoadmapMarkdown(plan) {
  const phases = (plan.roadmap.phases ?? []).map((phase) => {
    return [
      `### ${phase.name}`,
      "",
      renderList(phase.items)
    ].join("\n");
  });

  return [
    "# Roadmap",
    "",
    `## ${plan.roadmap.milestoneName}`,
    "",
    plan.roadmap.milestoneGoal,
    "",
    ...phases
  ].join("\n");
}

export function renderStateMarkdown(plan) {
  return [
    "# State",
    "",
    "## Current Status",
    "",
    plan.state.currentStatus,
    "",
    "## Active Focus",
    "",
    plan.state.activeFocus,
    "",
    "## Next Step",
    "",
    plan.state.nextStep,
    "",
    "## Open Decisions",
    "",
    renderList(plan.state.openDecisions)
  ].join("\n");
}

function normalizeTask(task, index) {
  const rawId = task.id ?? `T${String(index + 1).padStart(3, "0")}`;
  return {
    id: rawId,
    phase: task.phase ?? "Phase 1",
    type: task.type ?? "planning",
    name: task.name ?? `Task ${index + 1}`,
    description: task.description ?? "Describe this task.",
    priority: task.priority ?? "P1",
    status: task.status ?? "todo",
    assignee: task.assignee ?? "owner",
    depends_on: Array.isArray(task.depends_on) ? task.depends_on : [],
    acceptance_criteria: Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : []
  };
}

export function normalizeProjectPlan(rawPlan) {
  const projectName = slugify(rawPlan.projectName || detectCurrentRootName() || "my-new-project");
  const scope = rawPlan.scope?.startsWith("@") ? rawPlan.scope : `@${projectName}`;
  const tasks = Array.isArray(rawPlan.tasks) ? rawPlan.tasks.map(normalizeTask) : [];

  return {
    projectName,
    scope,
    description: rawPlan.description || `Project scaffold for ${projectName}`,
    positioning: rawPlan.positioning || `Project initialized for ${projectName}.`,
    currentAssumption: rawPlan.currentAssumption || "The project idea has been clarified with the user and is ready for execution.",
    targetUsers: Array.isArray(rawPlan.targetUsers) ? rawPlan.targetUsers : [],
    desiredOutcome: rawPlan.desiredOutcome || "Deliver the smallest useful product slice and continue autonomously.",
    requirements: {
      inScope: Array.isArray(rawPlan.requirements?.inScope) ? rawPlan.requirements.inScope : [],
      outOfScope: Array.isArray(rawPlan.requirements?.outOfScope) ? rawPlan.requirements.outOfScope : [],
      notes: Array.isArray(rawPlan.requirements?.notes) ? rawPlan.requirements.notes : []
    },
    roadmap: {
      milestoneName: rawPlan.roadmap?.milestoneName || "Milestone 1: MVP foundation",
      milestoneGoal: rawPlan.roadmap?.milestoneGoal || "Turn the idea into a first shippable slice.",
      phases: Array.isArray(rawPlan.roadmap?.phases) ? rawPlan.roadmap.phases : []
    },
    state: {
      currentStatus: rawPlan.state?.currentStatus || "Project initialized from intake conversation.",
      activeFocus: rawPlan.state?.activeFocus || "Finalize the MVP definition and start implementation.",
      nextStep: rawPlan.state?.nextStep || "Start the highest-priority task.",
      openDecisions: Array.isArray(rawPlan.state?.openDecisions) ? rawPlan.state.openDecisions : []
    },
    tasks,
    progressEntry: rawPlan.progressEntry || `Intake completed for ${projectName}. Planning artifacts and execution queue were generated.`
  };
}

export function writeProjectPlan(plan) {
  writeText(".planning/PROJECT.md", renderProjectMarkdown(plan));
  writeText(".planning/REQUIREMENTS.md", renderRequirementsMarkdown(plan));
  writeText(".planning/ROADMAP.md", renderRoadmapMarkdown(plan));
  writeText(".planning/STATE.md", renderStateMarkdown(plan));
  writeJson("dev/task.json", {
    project: plan.projectName,
    version: "0.1.0",
    created_at: new Date().toISOString().slice(0, 10),
    updated_at: new Date().toISOString().slice(0, 10),
    tasks: plan.tasks
  });
}

export function appendProgressEntry(entry, maxRetries = 3) {
  const normalizedEntry = String(entry ?? "").replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/u, "").trim();
  const line = `[${new Date().toISOString().slice(0, 10)}] ${normalizedEntry}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const existing = readText("dev/progress.txt").trim();
      writeText("dev/progress.txt", existing ? `${existing}\n${line}\n` : `${line}\n`);
      return;
    } catch (err) {
      if ((err.code === "EACCES" || err.code === "EPERM") && attempt < maxRetries) {
        // Brief synchronous delay before retry
        const sharedBuffer = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(sharedBuffer), 0, 0, 50 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}
