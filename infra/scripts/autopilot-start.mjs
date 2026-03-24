import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { spawn, execSync, spawnSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildShellCommandLine,
  ensureDir,
  formatDuration,
  getExecutable,
  parseQuotaResetWaitSeconds,
  pathExists,
  readJson,
  readText,
  requiresCommandShell,
  rootDir,
  sleep,
  writeJson,
  isWorkingTreeClean,
  getCurrentBranch
} from "./lib/utils.mjs";
import {
  DEFAULT_AUTOPILOT_CONFIG,
  fillTemplateArgs,
  loadAutopilotConfig,
  probeRunner,
  renderRunnerSummary,
  resolveRunnerProfile
} from "./lib/autopilot-runner.mjs";
import { notify } from "./lib/notifications.mjs";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const runOnce = args.includes("--once");
const continueReview = args.includes("--continue-review");
const acceptAsIs = args.includes("--accept-as-is");

function loadConfig() {
  ensureDir(".autopilot");
  if (!pathExists(".autopilot/config.json")) {
    writeJson(".autopilot/config.json", DEFAULT_AUTOPILOT_CONFIG);
  }
  return loadAutopilotConfig({ persist: true });
}

/** Cached state to avoid redundant file reads within a single loop iteration. */
let _stateCache = null;

function loadState() {
  if (_stateCache) {
    return _stateCache;
  }
  const state = readJson(".autopilot/state.json", {
    status: "idle",
    sessionId: "",
    retryCount: 0,
    round: 0,
    lastExitCode: null,
    lastTaskId: null,
    updatedAt: new Date().toISOString()
  });
  _stateCache = state;
  return state;
}

function saveState(nextState) {
  const merged = {
    ...nextState,
    updatedAt: new Date().toISOString()
  };
  writeJson(".autopilot/state.json", merged);
  // Update cache so subsequent loadState() calls in the same iteration
  // return the freshly saved state without re-reading from disk.
  _stateCache = merged;
}

/** Invalidate the state cache. Call once per loop iteration to pick up external changes. */
function invalidateStateCache() {
  _stateCache = null;
}

function clearStopSignal() {
  if (pathExists(".autopilot/.stop")) {
    rmSync(".autopilot/.stop", { force: true });
  }
}

/** Load and filter valid tasks from dev/task.json. */
function getTasks() {
  const raw = readJson("dev/task.json", { tasks: [] }).tasks ?? [];
  return raw.filter((task) => task && task.id);
}

/** @deprecated Use getReadyTasks()[0] instead. Kept for backward compatibility with tests. */
function getNextTask() {
  const tasks = getTasks();

  for (const priority of ["P0", "P1", "P2"]) {
    for (const task of tasks) {
      if (task.status !== "todo" || task.priority !== priority) {
        continue;
      }

      const dependencies = task.depends_on ?? [];
      const depsSatisfied = dependencies.every((dependencyId) => {
        const dependencyTask = tasks.find((candidate) => candidate.id === dependencyId);
        if (!dependencyTask) {
          console.warn(`WARNING: Task "${task.id}" depends on unknown task "${dependencyId}" — treating as unsatisfied. Check dev/task.json for typos or remove the stale dependency.`);
          return false;
        }
        return dependencyTask.status === "done";
      });

      if (depsSatisfied) {
        return task;
      }
    }
  }

  return null;
}

/**
 * Detect circular dependencies in the task graph using DFS graph coloring.
 * @param {Array<{id: string, depends_on?: string[]}>} tasks
 * @returns {string[][]} Array of cycles, each cycle is an array of task IDs
 */
export function detectCycles(tasks) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map(tasks.map((t) => [t.id, WHITE]));
  const parent = new Map();
  const cycles = [];

  function dfs(taskId) {
    color.set(taskId, GRAY);
    const task = tasks.find((t) => t.id === taskId);
    const deps = task?.depends_on ?? [];
    for (const depId of deps) {
      if (!color.has(depId)) {
        continue;
      }
      if (color.get(depId) === GRAY) {
        const cycle = [depId];
        let current = taskId;
        while (current !== depId) {
          cycle.unshift(current);
          current = parent.get(current);
          if (current === undefined) {
            break;
          }
        }
        cycle.push(depId);
        cycles.push(cycle);
      } else if (color.get(depId) === WHITE) {
        parent.set(depId, taskId);
        dfs(depId);
      }
    }
    color.set(taskId, BLACK);
  }

  for (const task of tasks) {
    if (color.get(task.id) === WHITE) {
      dfs(task.id);
    }
  }

  return cycles;
}

/**
 * Get all todo tasks whose dependencies are satisfied and are not in cycles.
 * Tasks are returned in priority order (P0 → P1 → P2).
 */
function getReadyTasks() {
  const tasks = getTasks();
  const ready = [];

  const cycles = detectCycles(tasks);
  const cycleTaskIds = new Set();
  for (const cycle of cycles) {
    const cycleWithoutDuplicate = cycle.slice(0, -1);
    const label = cycle.join(" → ");
    console.warn(`WARNING: Circular dependency detected: ${label} — check task dependencies in dev/task.json or reassign blocked tasks`);
    for (const id of cycleWithoutDuplicate) {
      cycleTaskIds.add(id);
    }
  }

  for (const priority of ["P0", "P1", "P2"]) {
    for (const task of tasks) {
      if (task.status !== "todo" || task.priority !== priority) {
        continue;
      }

      if (cycleTaskIds.has(task.id)) {
        continue;
      }

      const dependencies = task.depends_on ?? [];
      const depsSatisfied = dependencies.every((dependencyId) => {
        const dependencyTask = tasks.find((candidate) => candidate.id === dependencyId);
        if (!dependencyTask) {
          console.warn(`WARNING: Task "${task.id}" depends on unknown task "${dependencyId}" — treating as unsatisfied. Check dev/task.json for typos or remove the stale dependency.`);
          return false;
        }
        return dependencyTask.status === "done";
      });

      if (depsSatisfied) {
        ready.push(task);
      }
    }
  }

  return ready;
}

function getProgressTail() {
  const content = readText("dev/progress.txt", "progress.txt not found");
  const lines = content.split(/\r?\n/u).filter(Boolean);
  return lines.slice(-20).join("\n");
}

/**
 * Parse the completion status protocol line from agent output.
 * Agents should emit a STATUS: line as one of the last 20 lines of output.
 * Recognized statuses: DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT.
 * Returns { status, details, raw } where raw=true means a STATUS line was found.
 */
function parseCompletionStatus(output) {
  if (!output) return { status: "DONE", details: "", raw: false };
  const lines = output.split(/\r?\n/).slice(-20);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^STATUS:\s*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)\s*(?:(?:—|--|[-–])\s*(.*))?$/u);
    if (match) {
      return { status: match[1], details: (match[2] ?? "").trim(), raw: true };
    }
  }
  return { status: "DONE", details: "", raw: false };
}

function appendProgressEntry(text) {
  if (!existsSync("dev/progress.txt")) {
    mkdirSync("dev", { recursive: true });
    writeFileSync("dev/progress.txt", "", "utf8");
  }
  appendFileSync("dev/progress.txt", `${text}\n`, "utf8");
}

/**
 * Post-task git safety net: check for uncommitted changes and auto-commit them.
 * This catches cases where the agent forgets to commit after completing a task.
 * Uses `git add -A` which respects .gitignore, so sensitive files are not committed.
 */
function ensureCleanWorkingTree(taskId, taskName) {
  try {
    const status = execSync("git status --porcelain", { encoding: "utf8", timeout: 10000 }).trim();
    if (!status) return; // already clean

    // Auto-stage and commit uncommitted changes (using spawnSync to avoid shell injection)
    const addResult = spawnSync("git", ["add", "-A"], { timeout: 10000, stdio: "pipe" });
    if (addResult.status !== 0) {
      console.warn(`⚠ Auto-commit skipped after task ${taskId}: git add failed — manual commit may be needed`);
      return;
    }
    const msg = `chore: auto-commit after task ${taskId} — ${taskName}`;
    const commitResult = spawnSync("git", ["commit", "-m", msg], { encoding: "utf8", timeout: 30000, stdio: "pipe" });
    if (commitResult.status !== 0) throw new Error(commitResult.stderr || "git commit failed");
    appendProgressEntry(`Auto-committed uncommitted changes after task ${taskId}`);
  } catch (err) {
    console.warn(`⚠ Auto-commit failed after task ${taskId}: ${err.message} — manual commit may be needed`);
  }
}

/**
 * Session-end push: push the current branch to the remote.
 * Called when all tasks are complete or final review converges.
 * NOT called on SIGINT (user may not want to push).
 */
function pushToRemote() {
  try {
    const remote = execSync("git remote", { encoding: "utf8", timeout: 5000 }).trim().split(/\r?\n/)[0];
    if (!remote) return;
    const branch = getCurrentBranch();
    if (branch === "unknown") return;
    console.log(`Pushing to ${remote}/${branch}...`);
    const pushResult = spawnSync("git", ["push", remote, branch], { encoding: "utf8", timeout: 60000, stdio: "pipe" });
    if (pushResult.status !== 0) throw new Error(pushResult.stderr || "git push failed");
    console.log(`✓ Pushed to ${remote}/${branch}`);
    appendProgressEntry(`Pushed to ${remote}/${branch}`);
  } catch (err) {
    console.warn(`⚠ Auto-push failed: ${err.message} — push manually with: git push`);
  }
}

function getTaskProgressSummary() {
  const tasks = getTasks();
  return {
    done: tasks.filter((task) => task.status === "done").length,
    skipped: tasks.filter((task) => task.status === "skipped").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    total: tasks.length
  };
}

/**
 * Compute the max review rounds dynamically based on project complexity and review strategy.
 *
 * Review strategies (from .planning/config.json review_strategy.mode):
 *   "auto"     — scale by project complexity (default)
 *   "zero_bug" — review until bugs < threshold (uses a high cap, convergence checked separately)
 *   "custom"   — user-specified fixed number
 *
 * Auto tiers:
 *   Small  (≤10 tasks, ≤20 files)  → 5 rounds
 *   Medium (≤30 tasks, ≤50 files)  → 7 rounds
 *   Large  (≤60 tasks, ≤100 files) → 10 rounds
 *   XL     (>60 tasks or >100 files) → 12 rounds
 *
 * @param {object} opts
 * @param {number} opts.taskCount - Total number of tasks in dev/task.json
 * @param {number} opts.sourceFileCount - Number of source files in apps/ + packages/
 * @param {number|string|undefined} opts.configMaxRounds - Value from final_review config (number, "auto", or undefined)
 * @param {object} [opts.reviewStrategy] - Review strategy from .planning/config.json
 * @param {string} [opts.reviewStrategy.mode] - "auto" | "zero_bug" | "custom"
 * @param {number} [opts.reviewStrategy.custom_rounds] - Fixed round count for "custom" mode
 * @returns {number} The computed max review rounds
 */
function computeMaxReviewRounds({ taskCount = 0, sourceFileCount = 0, configMaxRounds, reviewStrategy } = {}) {
  // Review strategy takes priority
  if (reviewStrategy?.mode === "zero_bug") {
    // High cap — actual convergence is checked by bug count in the main loop
    return 50;
  }

  if (reviewStrategy?.mode === "custom" && typeof reviewStrategy.custom_rounds === "number" && reviewStrategy.custom_rounds > 0) {
    return reviewStrategy.custom_rounds;
  }

  // Explicit numeric override from final_review config
  if (typeof configMaxRounds === "number" && configMaxRounds > 0) {
    return configMaxRounds;
  }

  // Auto-scale based on complexity
  const tc = taskCount;
  const fc = sourceFileCount;

  if (tc > 60 || fc > 100) return 12;
  if (tc > 30 || fc > 50)  return 10;
  if (tc > 10 || fc > 20)  return 7;
  return 5;
}

/**
 * Count source files in apps/ and packages/ directories.
 * Uses Node.js fs to work cross-platform (the previous `find` command always returned 0 on Windows).
 * Falls back to 0 if directories don't exist.
 * @returns {number}
 */
function countSourceFiles() {
  const SOURCE_EXTENSIONS = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"]);

  function countRecursive(dir) {
    let count = 0;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules and hidden directories
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        count += countRecursive(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext)) {
          count += 1;
        }
      }
    }
    return count;
  }

  const appsDir = path.join(rootDir, "apps");
  const packagesDir = path.join(rootDir, "packages");
  return countRecursive(appsDir) + countRecursive(packagesDir);
}

function resolveModel(task, config) {
  if (!task) {
    // Idle / no task — use planning model
    return config.models.planning;
  }

  // Opus-assigned tasks or planning/review types use the planning (opus) model
  const assignee = (task.assignee ?? "").toLowerCase();
  if (assignee === "opus") {
    return config.models.planning;
  }

  // Codex/Gemini tasks are delegated via the orchestrator prompt, which needs opus
  if (assignee === "codex" || assignee === "gemini") {
    return config.models.planning;
  }

  // Tasks explicitly typed as planning, review, or docs use the planning model
  const taskType = (task.type ?? "").toLowerCase();
  if (taskType === "planning" || taskType === "review" || taskType === "docs" || taskType === "research") {
    return config.models.planning;
  }

  // Default: implementation tasks use the execution model (sonnet)
  return config.models.execution ?? config.models.planning;
}

/**
 * Load review gate configuration and build review instructions for the prompt.
 * Matches task type and affected files to determine which review recipes apply.
 * @param {object|null} task - Current task (or null for idle mode)
 * @returns {string} Review gate instructions to inject into the prompt, or empty string
 */
function buildReviewGateInstructions(task) {
  if (!task) return "";

  const planConfig = readJson(".planning/config.json", {});
  const reviewGates = planConfig?.review_gates;
  if (!reviewGates) return "";

  const taskType = task.type ?? "";
  const taskName = (task.name ?? "").toLowerCase();
  const taskDesc = (task.description ?? "").toLowerCase();

  const applicableGates = [];

  // Match gates by task type and content
  if (reviewGates.mrd_prd_review?.enabled) {
    if (taskType === "research" || taskType === "planning" ||
        taskName.includes("mrd") || taskName.includes("prd") ||
        taskName.includes("requirement") || taskDesc.includes("market research") ||
        taskDesc.includes("product requirement")) {
      applicableGates.push({
        name: "MRD/PRD Review",
        recipe: reviewGates.mrd_prd_review.recipe,
        tools: reviewGates.mrd_prd_review.tools,
        blocking: reviewGates.mrd_prd_review.blocking
      });
    }
  }

  if (reviewGates.tech_design_review?.enabled) {
    if (taskType === "docs" ||
        taskName.includes("tech spec") || taskName.includes("design") ||
        taskName.includes("architecture") || taskDesc.includes("technical spec") ||
        taskDesc.includes("design doc")) {
      applicableGates.push({
        name: "Tech/Design Review",
        recipe: reviewGates.tech_design_review.recipe,
        tools: reviewGates.tech_design_review.tools,
        blocking: reviewGates.tech_design_review.blocking
      });
    }
  }

  if (reviewGates.code_review?.enabled) {
    if (taskType === "implementation" || taskType === "review") {
      applicableGates.push({
        name: "Code Review",
        recipe: reviewGates.code_review.recipe,
        tools: reviewGates.code_review.tools,
        blocking: reviewGates.code_review.blocking
      });
    }
  }

  if (reviewGates.test_coverage_review?.enabled) {
    if (taskType === "testing" ||
        taskName.includes("test") || taskDesc.includes("test coverage")) {
      applicableGates.push({
        name: "Test Coverage Review",
        recipe: reviewGates.test_coverage_review.recipe,
        tools: reviewGates.test_coverage_review.tools,
        blocking: reviewGates.test_coverage_review.blocking,
        extra: "IMPORTANT: Build a PRD-to-test coverage matrix. Every PRD requirement MUST have at least one test. 100% coverage required."
      });
    }
  }

  if (reviewGates.marketing_review?.enabled) {
    if (taskName.includes("marketing") || taskName.includes("gtm") ||
        taskName.includes("launch") || taskDesc.includes("marketing") ||
        taskDesc.includes("go-to-market")) {
      applicableGates.push({
        name: "Marketing Review",
        recipe: reviewGates.marketing_review.recipe,
        tools: reviewGates.marketing_review.tools,
        blocking: reviewGates.marketing_review.blocking
      });
    }
  }

  if (applicableGates.length === 0) return "";

  const lines = [
    "",
    "## Review Gates (MANDATORY)",
    "The following review gates apply to this task. You MUST complete them before marking the task done.",
    ""
  ];

  for (const gate of applicableGates) {
    const blockLabel = gate.blocking ? "BLOCKING" : "Advisory";
    lines.push(`### ${gate.name} [${blockLabel}]`);
    lines.push(`- Recipe: Read and follow \`${gate.recipe}\``);
    lines.push(`- Tools: ${gate.tools.join(", ")}`);
    if (gate.extra) {
      lines.push(`- ${gate.extra}`);
    }
    lines.push(`- Record review result in \`dev/review/REVIEW-${gate.name.replace(/[/ ]/g, "-").toUpperCase()}-${task.id}.md\``);
    lines.push("");
  }

  lines.push("If any BLOCKING review FAILS: do NOT mark the task as done. Instead, fix the issues and re-review.");

  return lines.join("\n");
}

/**
 * Sanitizes a task ID for safe use in file paths, branch names, and shell commands.
 * Matches the PS-side regex in worktree.ps1.
 * Appends a short hash suffix when the original ID differs from its sanitized form
 * to avoid collisions (e.g., "feat/login" vs "feat-login" → different safe IDs).
 */
function sanitizeTaskId(id) {
  const raw = String(id ?? "");
  // No /u flag — match PS UTF-16 code-unit semantics for astral Unicode parity (#R4-7)
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (sanitized === raw) return sanitized;
  // Append 4-char hex hash to disambiguate lossy sanitization (same djb2 as PS side)
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  const suffix = (hash >>> 0).toString(16).slice(-4).padStart(4, "0");
  return `${sanitized}-${suffix}`;
}

/**
 * Checks whether Codex delegation prerequisites are available.
 * Returns { available: boolean, issues: string[] }
 */
function checkCodexPrerequisites() {
  const issues = [];
  const bridgePath = path.join(rootDir, "codex-bridge", "CodexBridge.psm1");
  if (!pathExists(bridgePath)) {
    issues.push("codex-bridge/CodexBridge.psm1 not found");
  }
  // Check codex CLI availability (not just file existence)
  {
    const result = spawnSync("codex", ["--version"], { stdio: "pipe", timeout: 5000 });
    if (result.status !== 0) {
      issues.push("codex CLI not found or not executable (install with: npm install -g @openai/codex)");
    }
  }
  return { available: issues.length === 0, issues };
}

/**
 * Checks whether Gemini delegation prerequisites are available.
 * Returns { available: boolean, issues: string[] }
 */
function checkGeminiPrerequisites() {
  const issues = [];
  const bridgePath = path.join(rootDir, "gemini-bridge", "GeminiBridge.psm1");
  if (!pathExists(bridgePath)) {
    issues.push("gemini-bridge/GeminiBridge.psm1 not found");
  }
  // Check gemini CLI availability
  const geminiVersionResult = spawnSync("gemini", ["--version"], { stdio: "pipe", timeout: 5000 });
  if (geminiVersionResult.status !== 0 || geminiVersionResult.error) {
    issues.push("gemini CLI not found or not executable (install with: npm install -g @google/gemini-cli)");
  } else if (!geminiVersionResult.stdout || !geminiVersionResult.stdout.toString().trim()) {
    issues.push("gemini CLI found but returned empty version");
  }
  return { available: issues.length === 0, issues };
}

/**
 * Builds Codex delegation instructions for the prompt.
 * When Opus is the main runner but a task is assigned to Codex,
 * instruct Opus to delegate via the codex-bridge module.
 *
 * Uses absolute paths and powershell.exe (not pwsh) for WinPS 5.1 compatibility.
 */
function buildCodexDelegationBlock(task) {
  const rawId = task.id;
  // Use absolute paths so commands work regardless of CWD
  // Escape single quotes for safe embedding in PS -Command strings (#R4-6)
  const absRoot = rootDir.replace(/\//g, "\\").replace(/'/g, "''");
  const modulePath = `${absRoot}\\codex-bridge\\CodexBridge.psm1`;
  // Escape single quotes in rawId for safe PS single-quoted string embedding
  // Escape for PS single-quoted strings: backtick → ``, $ → `$, ' → '', newlines stripped
  const escapePs = (s) => (s ?? "")
    .replace(/`/g, "``")        // must come first to avoid double-escaping
    .replace(/\$/g, "`$")       // prevent variable expansion
    .replace(/'/g, "''")        // PS single-quote escape
    .replace(/[\r\n]+/g, " ");  // collapse newlines to space
  const escapedRawId = escapePs(rawId);
  const escapedName = escapePs(task.name);
  return [
    `This task is assigned to **Codex (GPT)**. Delegate via the CodexBridge PowerShell module.`,
    ``,
    `a. First, analyze the task and identify which source files Codex needs as context.`,
    `b. Import the module and run the full lifecycle in one call:`,
    `   \`\`\`powershell`,
    `   Import-Module '${modulePath}'`,
    `   $task = @{ id='${escapedRawId}'; name='${escapedName}'; description='${escapePs(task.description)}'; steps=@(${(task.steps ?? []).map(s => `'${escapePs(s)}'`).join(",")}); acceptance_criteria=@(${(task.acceptance_criteria ?? []).map(s => `'${escapePs(s)}'`).join(",")}) }`,
    `   $result = Invoke-Codex -TaskId '${escapedRawId}' -Task $task -ProjectRoot '${absRoot}'`,
    `   \`\`\``,
    `c. Review the result using module functions:`,
    `   \`\`\`powershell`,
    `   $review = Get-CodexReviewSummary -Result $result -ProjectRoot '${absRoot}'`,
    `   Format-ReviewForClaude -Review $review`,
    `   \`\`\``,
    `d. Accept or reject:`,
    `   \`\`\`powershell`,
    `   Complete-CodexTask -Result $result -Verdict "accept" -ProjectRoot '${absRoot}'  # or "reject"`,
    `   \`\`\``,
    ``,
    `IMPORTANT: Always use the module API above. Do NOT run manual git worktree/merge/branch commands.`,
    ``
  ].join("\n");
}

/**
 * Builds Gemini delegation instructions for the prompt.
 * When Opus is the main runner but a task is assigned to Gemini,
 * instruct Opus to delegate via the gemini-bridge module.
 *
 * Uses absolute paths and powershell.exe (not pwsh) for WinPS 5.1 compatibility.
 */
function buildGeminiDelegationBlock(task) {
  const rawId = task.id;
  const absRoot = rootDir.replace(/\//g, "\\").replace(/'/g, "''");
  const modulePath = `${absRoot}\\gemini-bridge\\GeminiBridge.psm1`;
  // Escape for PS single-quoted strings: backtick → ``, $ → `$, ' → '', newlines stripped
  const escapePs = (s) => (s ?? "")
    .replace(/`/g, "``")        // must come first to avoid double-escaping
    .replace(/\$/g, "`$")       // prevent variable expansion
    .replace(/'/g, "''")        // PS single-quote escape
    .replace(/[\r\n]+/g, " ");  // collapse newlines to space
  const escapedRawId = escapePs(rawId);
  const escapedName = escapePs(task.name);
  return [
    `This task is assigned to **Gemini (Google)**. Delegate via the GeminiBridge PowerShell module.`,
    ``,
    `a. First, analyze the task and identify which source files Gemini needs as context.`,
    `b. Import the module and run the full lifecycle in one call:`,
    `   \`\`\`powershell`,
    `   Import-Module '${modulePath}'`,
    `   $task = @{ id='${escapedRawId}'; name='${escapedName}'; description='${escapePs(task.description)}'; steps=@(${(task.steps ?? []).map(s => `'${escapePs(s)}'`).join(",")}); acceptance_criteria=@(${(task.acceptance_criteria ?? []).map(s => `'${escapePs(s)}'`).join(",")}) }`,
    `   $result = Invoke-Gemini -TaskId '${escapedRawId}' -Task $task -ProjectRoot '${absRoot}'`,
    `   \`\`\``,
    `c. Review the result using module functions:`,
    `   \`\`\`powershell`,
    `   $review = Get-GeminiReviewSummary -Result $result -ProjectRoot '${absRoot}'`,
    `   Format-GeminiReviewForClaude -Review $review`,
    `   \`\`\``,
    `d. Accept or reject:`,
    `   \`\`\`powershell`,
    `   Complete-GeminiTask -Result $result -Verdict "accept" -ProjectRoot '${absRoot}'  # or "reject"`,
    `   \`\`\``,
    ``,
    `IMPORTANT: Always use the module API above. Do NOT run manual git worktree/merge/branch commands.`,
    ``
  ].join("\n");
}

/**
 * Build the system prompt for the AI runner based on ready tasks and config.
 * Handles four modes: multi-task (Opus orchestrator), single-task (Sonnet worker),
 * codex delegation, and idle (task generation or audit).
 * @param {Array} readyTasks - Tasks with all dependencies satisfied
 * @param {object} config - Autopilot configuration
 * @returns {string} The complete prompt text
 */

/**
 * Returns the ordered list of skills for a given execution phase.
 * Reads execution_order from .ai/skills/skill-registry.json.
 * @param {string} phase - Phase key: "implement_frontend" | "review_frontend" | "final_review"
 * @returns {string[]} Ordered array of skill identifiers (e.g. ["impeccable/critique", ...])
 */
function getSkillExecutionOrder(phase) {
  const registry = readJson(".ai/skills/skill-registry.json", null);
  if (!registry?.execution_order) return [];
  return registry.execution_order[phase] ?? [];
}

/**
 * Topologically sort a list of skill identifiers using depends_on edges from the registry.
 * Skills with no dependencies come first; dependents come after their prerequisites.
 * @param {string[]} skillIds - List of "moduleId/skillName" identifiers to sort
 * @param {object} registry - The parsed skill registry object
 * @returns {string[]} Topologically sorted list
 */
function topoSortSkills(skillIds, registry) {
  // Build a dependency map from the registry
  const depMap = new Map();
  for (const [moduleId, mod] of Object.entries(registry.skills || {})) {
    for (const [skillName, skill] of Object.entries(mod.skills || {})) {
      const id = `${moduleId}/${skillName}`;
      depMap.set(id, skill.depends_on || null);
    }
  }

  const visited = new Set();
  const sorted = [];
  const inProgress = new Set();

  function visit(id) {
    if (visited.has(id)) return;
    if (inProgress.has(id)) {
      console.warn(`[skills] Circular dependency detected involving skill: ${id}`);
      return; // cycle guard — skip to avoid infinite loop
    }
    inProgress.add(id);
    const dep = depMap.get(id);
    if (dep && skillIds.includes(dep)) {
      visit(dep);
    }
    inProgress.delete(id);
    visited.add(id);
    sorted.push(id);
  }

  for (const id of skillIds) {
    visit(id);
  }

  return sorted;
}

/**
 * Load external skill instructions based on task type and current phase.
 * Reads .ai/skills/skill-registry.json and returns relevant skill instructions
 * to inject into the prompt. Skills are sorted topologically by depends_on edges,
 * and an execution order note is appended to the block.
 * @param {Array} tasks - Current tasks being executed
 * @param {string} phase - Current phase: "implement" | "review" | "final_review"
 * @returns {string} Skill instructions block, or empty string if no skills match
 */
function loadSkillInstructions(tasks, phase = "implement") {
  const registry = readJson(".ai/skills/skill-registry.json", null);
  if (!registry?.skills) return "";

  const taskTags = new Set();
  for (const t of tasks) {
    const type = (t.type || "").toLowerCase();
    const name = (t.name || "").toLowerCase();
    const desc = (t.description || "").toLowerCase();
    const combined = `${type} ${name} ${desc}`;
    for (const tag of ["frontend", "ui", "design", "component", "page", "layout", "accessibility", "ux"]) {
      if (combined.includes(tag)) taskTags.add(tag);
    }
  }

  if (taskTags.size === 0) return "";

  // Collect all matching skill IDs so we can topo-sort them
  const matchedSkillIds = [];
  const matchedModules = [];

  for (const [moduleId, mod] of Object.entries(registry.skills)) {
    const trigger = mod.trigger || {};
    const phaseMatch = (trigger.phase || []).includes(phase);
    const tagMatch = (trigger.task_tags || []).some((tag) => taskTags.has(tag));
    if (!phaseMatch && !tagMatch) continue;

    // Filter individual skills by their phase field when present
    const allSkillEntries = Object.entries(mod.skills || {});
    const skillEntries = allSkillEntries.filter(([, skill]) => {
      const skillPhases = skill.phases ?? (skill.phase ? [skill.phase] : null);
      if (!skillPhases) return true; // no phase restriction on skill — include it
      return skillPhases.includes(phase);
    });
    if (skillEntries.length === 0) continue;

    matchedModules.push({ moduleId, mod, skillEntries });
    for (const [skillName] of skillEntries) {
      matchedSkillIds.push(`${moduleId}/${skillName}`);
    }
  }

  if (matchedModules.length === 0) return "";

  // Topologically sort the matched skill IDs
  const sortedSkillIds = topoSortSkills(matchedSkillIds, registry);

  const parts = [];
  for (const { moduleId, mod, skillEntries } of matchedModules) {
    // Re-sort this module's skills according to the topo order
    const orderedEntries = [...skillEntries].sort((a, b) => {
      const idxA = sortedSkillIds.indexOf(`${moduleId}/${a[0]}`);
      const idxB = sortedSkillIds.indexOf(`${moduleId}/${b[0]}`);
      return idxA - idxB;
    });

    const skillList = orderedEntries
      .map(([name, skill]) => {
        const depNote = skill.depends_on ? ` (after ${skill.depends_on})` : "";
        return `  - **${name}**${depNote}: ${skill.when || ""}  \n    File: \`.ai/skills/${mod.path?.replace(".ai/skills/", "") || moduleId}/${skill.file}\``;
      })
      .join("\n");

    parts.push(
      `### Skill Module: ${moduleId}`,
      mod.description || "",
      `Source: ${mod.source || "bundled"}`,
      "",
      "Available skills:",
      skillList
    );

    if (mod.reference?.files?.length) {
      parts.push(
        "",
        "Reference docs (read as needed):",
        ...mod.reference.files.map((f) => `  - .ai/skills/${mod.path?.replace(".ai/skills/", "") || moduleId}/${mod.reference.path}${f}`)
      );
    }
    parts.push("");
  }

  // Add phase-specific instructions from phase_mapping
  const phaseMap = registry.phase_mapping || {};
  const phaseKey = phase === "implement" ? "implement_frontend"
    : phase === "review" ? "review_frontend"
    : phase === "final_review" ? "final_review"
    : null;

  if (phaseKey && phaseMap[phaseKey]) {
    const mapping = phaseMap[phaseKey];
    parts.push("### Phase-Specific Skill Usage");
    for (const [role, skills] of Object.entries(mapping)) {
      parts.push(`- **${role}**: Read and follow ${skills.join(", ")}`);
    }
    parts.push("");
  }

  // Append execution order note for this phase
  const executionOrderKey = phase === "implement" ? "implement_frontend"
    : phase === "review" ? "review_frontend"
    : phase === "final_review" ? "final_review"
    : null;

  const executionOrder = executionOrderKey ? getSkillExecutionOrder(executionOrderKey) : [];
  if (executionOrder.length > 0) {
    parts.push(`Skill execution order for this phase: ${executionOrder.join(" → ")}`);
    parts.push("");
  }

  return [
    "## Frontend Design Skills (External Modules)",
    "This project includes external skill modules for frontend design quality.",
    "Read the relevant skill files when working on frontend tasks.",
    "",
    ...parts
  ].join("\n");
}

function buildPrompt(readyTasks, config) {
  const progress = getProgressTail();
  const summary = getTaskProgressSummary();
  const task = readyTasks.length > 0 ? readyTasks[0] : null;
  const planConfig = readJson(".planning/config.json", {});
  const sharedHeaderParts = [
    "You are the continuous delivery agent for this repository.",
    "Operate autonomously and do not ask the user questions unless blocked by missing external information.",
    "",
    "## Mandatory Reading (every round)",
    "Read these files before making any changes:",
    "- AGENTS.md (role division, parallel strategy, quality gates, error handling rules)",
    "- .ai/recipes/error-handling-and-logging.md (error safety and logging standards — MANDATORY)",
    "- .planning/STATE.md (current status)",
    "- .planning/ROADMAP.md (phase sequence)",
    "- dev/task.json (task queue)",
    "",
    `Current task completion: ${summary.done}/${summary.total}`,
    "",
    "Recent progress:",
    progress || "(no progress logged yet)",
    ""
  ];

  // Optional modules instructions
  if (planConfig?.optional_modules?.payment?.enabled) {
    sharedHeaderParts.push(
      "## Enabled Module: Payment Integration",
      "This project has payment enabled. When implementing payment-related tasks:",
      "- Read .ai/recipes/payment-integration-guide.md for the full integration pattern",
      "- Generate checkout, webhook, and portal API routes following the guide",
      "- Auth guard required: checkout must verify authentication before proceeding",
      "- Webhook must verify signature against raw body and implement idempotency",
      "- Frontend must show login modal if user clicks checkout while unauthenticated",
      "- MUST generate /privacy and /terms pages — payment providers reject apps without them",
      "- MUST include a working support email in the footer — providers verify this",
      ""
    );
  }

  // Inject external skill modules for frontend tasks
  const skillBlock = loadSkillInstructions(readyTasks, "implement");
  if (skillBlock) {
    sharedHeaderParts.push(skillBlock, "");
  }

  const sharedHeader = sharedHeaderParts.join("\n");

  if (readyTasks.length > 1) {
    // Partition tasks by assignee
    const codexTasks = readyTasks.filter((t) => t.assignee === "codex");
    const geminiTasks = readyTasks.filter((t) => t.assignee === "gemini");
    const sonnetTasks = readyTasks.filter((t) => t.assignee !== "codex" && t.assignee !== "gemini" && t.assignee !== "opus");
    const opusTasks = readyTasks.filter((t) => t.assignee === "opus");

    let taskList = "";
    for (let i = 0; i < readyTasks.length; i++) {
      const t = readyTasks[i];
      const criteria = (t.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
      taskList += [
        `### Task ${i + 1}`,
        `- ID: ${t.id}`,
        `- Name: ${t.name}`,
        `- Type: ${t.type}`,
        `- Priority: ${t.priority}`,
        `- Assignee: ${t.assignee ?? "sonnet"}`,
        `- Description: ${t.description}`,
        "Acceptance criteria:",
        criteria || "- (none provided)",
        ""
      ].join("\n");
    }

    const strategyParts = [
      "## Execution Strategy",
      "You are the Opus orchestrator. Follow this workflow:",
      "",
      "1. Read AGENTS.md and relevant docs for these tasks."
    ];

    // Codex delegation instructions
    if (codexTasks.length > 0) {
      strategyParts.push(
        "",
        `### Codex Tasks (${codexTasks.length} tasks)`,
        "These tasks are assigned to Codex. For each one:"
      );
      for (const ct of codexTasks) {
        strategyParts.push("", `**${ct.id}: ${ct.name}**`, buildCodexDelegationBlock(ct));
      }
    }

    // Gemini delegation instructions
    if (geminiTasks.length > 0) {
      strategyParts.push(
        "",
        `### Gemini Tasks (${geminiTasks.length} tasks)`,
        "These tasks are assigned to Gemini. For each one:"
      );
      for (const gt of geminiTasks) {
        strategyParts.push("", `**${gt.id}: ${gt.name}**`, buildGeminiDelegationBlock(gt));
      }
    }

    // Opus direct tasks
    if (opusTasks.length > 0) {
      strategyParts.push(
        "",
        `### Opus Tasks (${opusTasks.length} tasks) — complete directly`,
        "These are planning/review tasks. Complete them yourself without sub-agents."
      );
    }

    // Sonnet parallel tasks
    if (sonnetTasks.length > 0) {
      strategyParts.push(
        "",
        `### Sonnet Tasks (${sonnetTasks.length} tasks)`,
        `2. Launch one Sonnet sub-Agent per task, all in parallel:`,
        "   - EVERY Agent MUST use `isolation: 'worktree'` and `model: 'sonnet'`.",
        "   - Each Agent gets its own git branch and working directory.",
        "3. After ALL Agents complete:",
        "   - Review each Agent's changes.",
        "   - Merge branches sequentially into the current branch.",
        "   - Resolve conflicts if any.",
        "   - After merging all worktree branches:",
        "     1. `git add -A`",
        "     2. `git commit -m \"feat(<taskId>): <taskName>\"` (use the primary task ID)",
        "     3. Verify: `git status` shows clean working tree"
      );
    }

    strategyParts.push(
      "",
      `${sonnetTasks.length > 0 ? "4" : "2"}. Run verification on the merged result.`,
      `${sonnetTasks.length > 0 ? "5" : "3"}. Update dev/task.json — set ALL completed tasks to done.`,
      `${sonnetTasks.length > 0 ? "6" : "4"}. Update dev/progress.txt with what was accomplished for each task.`,
      `${sonnetTasks.length > 0 ? "7" : "5"}. Update .planning/STATE.md.`,
      `${sonnetTasks.length > 0 ? "8" : "6"}. Git commit all final changes together.`
    );

    // Collect review gates for all ready tasks
    const batchReviewGates = readyTasks
      .map((t) => buildReviewGateInstructions(t))
      .filter(Boolean)
      .join("\n");

    return [
      sharedHeader,
      `## Ready Tasks (${readyTasks.length} tasks with all dependencies satisfied)`,
      "",
      "The following tasks are ALL ready to execute. Execute as many in parallel as possible.",
      "",
      taskList,
      ...strategyParts,
      batchReviewGates,
      "",
      "## Deviation Rules",
      "If you encounter unexpected situations during execution, follow AGENTS.md deviation rules:",
      "- D1-D3 (cosmetic, missing dep, unrelated test failure): Auto-fix and log in progress.txt",
      "- D4-D5 (ambiguous requirement, architectural decision): STOP immediately, mark task as blocked in task.json, log reason in STATE.md"
    ].join("\n");
  }

  if (task) {
    const criteria = (task.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
    const smallThreshold = config.scaleThresholds?.small ?? 2;
    const mediumThreshold = config.scaleThresholds?.medium ?? 5;

    const taskHeader = [
      sharedHeader,
      "## Current Task",
      `- ID: ${task.id}`,
      `- Name: ${task.name}`,
      `- Type: ${task.type}`,
      `- Priority: ${task.priority}`,
      `- Assignee: ${task.assignee ?? "sonnet"}`,
      `- Description: ${task.description}`,
      "",
      "Acceptance criteria:",
      criteria || "- (none provided)",
      ""
    ];

    const reviewGateBlock = buildReviewGateInstructions(task);

    // Codex-assigned task: delegate via codex-bridge
    if (task.assignee === "codex") {
      return [
        ...taskHeader,
        "## Execution Strategy — Codex Delegation",
        "You are the Opus orchestrator. This task is assigned to Codex.",
        "",
        "1. Read AGENTS.md and relevant docs for this task.",
        `2. ${buildCodexDelegationBlock(task)}`,
        "3. After reviewing and merging (or rejecting):",
        "   - Run verification: build, lint, or test as appropriate.",
        "   - Update dev/task.json (set status to done).",
        "   - Update dev/progress.txt with what was accomplished.",
        "   - Update .planning/STATE.md if any decisions were made.",
        "   - Git commit all final changes together.",
        reviewGateBlock,
        "",
        "## Deviation Rules",
        "If you encounter unexpected situations during execution, follow AGENTS.md deviation rules:",
        "- D1-D3 (cosmetic, missing dep, unrelated test failure): Auto-fix and log in progress.txt",
        "- D4-D5 (ambiguous requirement, architectural decision): STOP immediately, mark task as blocked in task.json, log reason in STATE.md"
      ].join("\n");
    }

    // Gemini-assigned task: delegate via gemini-bridge
    if (task.assignee === "gemini") {
      return [
        ...taskHeader,
        "## Execution Strategy — Gemini Delegation",
        "You are the Opus orchestrator. This task is assigned to Gemini.",
        "",
        "1. Read AGENTS.md and relevant docs for this task.",
        `2. ${buildGeminiDelegationBlock(task)}`,
        "3. After reviewing and merging (or rejecting):",
        "   - Run verification: build, lint, or test as appropriate.",
        "   - Update dev/task.json (set status to done).",
        "   - Update dev/progress.txt with what was accomplished.",
        "   - Update .planning/STATE.md if any decisions were made.",
        "   - Git commit all final changes together.",
        reviewGateBlock,
        "",
        "## Deviation Rules",
        "If you encounter unexpected situations during execution, follow AGENTS.md deviation rules:",
        "- D1-D3 (cosmetic, missing dep, unrelated test failure): Auto-fix and log in progress.txt",
        "- D4-D5 (ambiguous requirement, architectural decision): STOP immediately, mark task as blocked in task.json, log reason in STATE.md"
      ].join("\n");
    }

    // Opus direct task
    if (task.assignee === "opus") {
      return [
        ...taskHeader,
        "## Execution Strategy — Direct (Opus)",
        "This is a planning/review task. Complete it directly without sub-agents.",
        "",
        "1. Read AGENTS.md and relevant docs for this task.",
        "2. Complete the task yourself (planning, review, or documentation).",
        "3. Update dev/task.json (set status to done).",
        "4. Update dev/progress.txt with what was accomplished.",
        "5. Update .planning/STATE.md if any decisions were made.",
        "6. Git commit all final changes together.",
        reviewGateBlock,
        "",
        "## Deviation Rules",
        "If you encounter unexpected situations during execution, follow AGENTS.md deviation rules:",
        "- D1-D3 (cosmetic, missing dep, unrelated test failure): Auto-fix and log in progress.txt",
        "- D4-D5 (ambiguous requirement, architectural decision): STOP immediately, mark task as blocked in task.json, log reason in STATE.md"
      ].join("\n");
    }

    // Default: Sonnet sub-agent execution
    return [
      ...taskHeader,
      "## Scale-Based Execution",
      "Before implementing, estimate how many files this task will touch:",
      `- 1-${smallThreshold} files (small): Execute directly with a single Sonnet agent`,
      `- ${smallThreshold + 1}-${mediumThreshold} files (medium): Write a brief plan first, then execute`,
      `- ${mediumThreshold + 1}+ files (large): MUST decompose into smaller subtasks before executing`,
      "",
      "## Execution Strategy",
      "You are the Opus orchestrator. Follow this workflow:",
      "",
      "1. Read AGENTS.md and relevant docs (PRD, tech spec) for this task.",
      "2. Analyze the task — break into independent subtasks if possible.",
      "3. Launch Sonnet sub-Agents with worktree isolation for parallel execution:",
      "   - EVERY coding Agent MUST use `isolation: 'worktree'` so each gets its own git branch.",
      "   - EVERY Agent MUST include `model: 'sonnet'` explicitly.",
      "   - With worktree isolation, agents CAN safely modify the same files.",
      "   - Example: Agent(model: 'sonnet', isolation: 'worktree', description: '...', prompt: '...')",
      "   - If multiple independent subtasks exist, launch ALL Agents in parallel.",
      "   - If the task is small enough for a single Agent, still use worktree isolation.",
      "4. After ALL worktree Agents complete:",
      "   - Review each Agent's changes (read the diff or key files).",
      "   - Merge changes from each worktree branch into the current branch.",
      "   - Resolve conflicts if any arise.",
      "   - After merging all worktree branches:",
      `     1. \`git add -A\``,
      `     2. \`git commit -m "feat(${task.id}): ${task.name}"\``,
      "     3. Verify: `git status` shows clean working tree",
      "5. Run verification: build, lint, or test as appropriate.",
      "6. Update dev/task.json (set status to done).",
      "7. Update dev/progress.txt with what was accomplished.",
      "8. Update .planning/STATE.md if any decisions were made.",
      "9. Git commit all final changes together.",
      reviewGateBlock,
      "",
      "## Deviation Rules",
      "If you encounter unexpected situations during execution, follow AGENTS.md deviation rules:",
      "- D1-D3 (cosmetic, missing dep, unrelated test failure): Auto-fix and log in progress.txt",
      "- D4-D5 (ambiguous requirement, architectural decision): STOP immediately, mark task as blocked in task.json, log reason in STATE.md"
    ].join("\n");
  }

  const idleInstruction = config.behavior.allowTaskGenerationWhenIdle
    ? "No runnable todo task exists. Read AGENTS.md, then inspect REQUIREMENTS, ROADMAP, and STATE. If the current milestone still has unfinished work, create 1-3 small next tasks in dev/task.json, update STATE/progress, and continue the project."
    : "No runnable todo task exists. Read AGENTS.md, then audit the repository, summarize whether the current milestone is complete, and stop if there is no clear next task.";

  return [
    sharedHeader,
    idleInstruction,
    "",
    "Guardrails:",
    "1. Do not invent large new scope.",
    "2. Keep tasks small and verifiable.",
    "3. Prefer planning the next slice over making risky assumptions.",
    "4. Follow deviation rules in AGENTS.md (D1-D3: auto-fix and log, D4-D5: STOP and mark blocked)."
  ].join("\n");
}

/**
 * Build the prompt for the final iteration review phase.
 * Instructs Opus to dispatch parallel reviewers (multi-AI), collect findings,
 * triage, create fix tasks, and loop until convergence.
 * @param {object} config - Autopilot configuration
 * @param {number} round - Current review round number (1-based)
 * @param {string|null} previousFindings - Summary of previous round findings, or null for first round
 * @returns {string} The final review prompt
 */
function buildFinalReviewPrompt(config, round, previousFindings, { codexAvailable, geminiAvailable } = {}) {
  const progress = getProgressTail();
  const summary = getTaskProgressSummary();
  const planConfig = readJson(".planning/config.json", {});
  const finalReviewConfig = planConfig?.final_review ?? {};
  const tasks = getTasks();
  const maxRounds = computeMaxReviewRounds({
    taskCount: tasks.length,
    sourceFileCount: countSourceFiles(),
    configMaxRounds: finalReviewConfig.max_rounds,
    reviewStrategy: planConfig?.review_strategy
  });
  const docReviewers = finalReviewConfig.parallel_reviewers?.docs ?? ["opus"];
  const codeReviewers = finalReviewConfig.parallel_reviewers?.code ?? ["sonnet"];
  // Check which optional skill files actually exist (they live in git submodules)
  const hasFrontendDesignSkill = pathExists(".ai/skills/impeccable/frontend-design.md");
  const hasAuditSkill = pathExists(".ai/skills/impeccable/audit.md");
  const hasWebDesignSkill = pathExists(".ai/skills/vercel-web-design/web-design-guidelines.md");
  // Use pre-computed prereq results if provided, otherwise compute once here
  const _codexAvailable = codexAvailable ?? checkCodexPrerequisites().available;
  const _geminiAvailable = geminiAvailable ?? checkGeminiPrerequisites().available;

  // Filter out codex/gemini if not available
  let activeDocReviewers = _codexAvailable ? docReviewers : docReviewers.filter((r) => r !== "codex");
  activeDocReviewers = _geminiAvailable ? activeDocReviewers : activeDocReviewers.filter((r) => r !== "gemini");
  let activeCodeReviewers = _codexAvailable ? codeReviewers : codeReviewers.filter((r) => r !== "codex");
  activeCodeReviewers = _geminiAvailable ? activeCodeReviewers : activeCodeReviewers.filter((r) => r !== "gemini");

  const reviewToolsSection = Object.entries(planConfig?.review_tools ?? {})
    .map(([name, info]) => `- **${name}**: ${info.description}`)
    .join("\n");

  const parts = [
    "You are the Opus orchestrator entering the FINAL ITERATION REVIEW phase.",
    `All ${summary.total} tasks are complete. Now audit the entire deliverable for quality.`,
    "",
    "## Mandatory Reading (every round)",
    "Read these files before proceeding:",
    "- AGENTS.md (role division, review gates, rationalization blockers)",
    "- .ai/recipes/review-final-iteration.md (this phase's full recipe)",
    "- .planning/STATE.md",
    "- docs/prd/ (the PRD that defines what was supposed to be built)",
    "",
    `## Final Review Round ${round}/${maxRounds}`,
    "",
    `Recent progress:`,
    progress || "(no progress logged yet)",
    ""
  ];

  if (previousFindings) {
    parts.push(
      "## Previous Round Findings",
      "The previous review round found these issues. Verify whether they have been fixed:",
      "",
      previousFindings,
      ""
    );
  }

  parts.push(
    "## Step 1: Dispatch Parallel Reviewers",
    "",
    "Launch ALL of the following review agents in parallel. Each reviewer works independently.",
    ""
  );

  // Document reviewers
  for (const reviewer of activeDocReviewers) {
    if (reviewer === "codex") {
      parts.push(
        "### Codex — Document Review",
        "Delegate to Codex CLI via codex-bridge (see AGENTS.md Codex Delegation Protocol).",
        "Codex reviews: MRD completeness, PRD quality, tech spec accuracy, design doc alignment.",
        ...(hasFrontendDesignSkill ? ["For frontend design docs: cross-check against .ai/skills/impeccable/frontend-design.md standards."] : []),
        "Output findings as a structured list in the handoff result.",
        ""
      );
    } else if (reviewer === "gemini") {
      parts.push(
        "### Gemini — Document Review",
        "Delegate to Gemini CLI via gemini-bridge (see AGENTS.md Gemini Delegation Protocol).",
        "Gemini reviews: MRD completeness, PRD quality, tech spec accuracy, design doc alignment.",
        ...(hasFrontendDesignSkill ? ["For frontend design docs: cross-check against .ai/skills/impeccable/frontend-design.md standards."] : []),
        "Output findings as a structured list in the handoff result.",
        ""
      );
    } else {
      const model = reviewer === "opus" ? "opus" : "sonnet";
      parts.push(
        `### ${reviewer.charAt(0).toUpperCase() + reviewer.slice(1)} — Document Review`,
        `Launch a sub-Agent with \`model: '${model}'\` (no worktree needed for read-only review).`,
        "Review: MRD completeness, PRD quality, tech spec accuracy, design doc alignment.",
        "Apply review-mrd-prd.md and review-tech-design.md recipes.",
        ...(hasFrontendDesignSkill ? ["For frontend design docs: cross-check against .ai/skills/impeccable/frontend-design.md standards."] : []),
        "Return a structured findings list.",
        ""
      );
    }
  }

  // Code reviewers
  for (const reviewer of activeCodeReviewers) {
    if (reviewer === "codex") {
      parts.push(
        "### Codex — Code & Test Review",
        "Delegate to Codex CLI via codex-bridge.",
        "Codex reviews: code quality, test coverage (build PRD-to-test matrix), TDD compliance, security.",
        ...(hasAuditSkill || hasWebDesignSkill ? [`For frontend: apply${hasAuditSkill ? " .ai/skills/impeccable/audit.md" : ""}${hasAuditSkill && hasWebDesignSkill ? " +" : ""}${hasWebDesignSkill ? " .ai/skills/vercel-web-design/web-design-guidelines.md" : ""}.`] : []),
        "Output findings as a structured list.",
        ""
      );
    } else if (reviewer === "gemini") {
      parts.push(
        "### Gemini — Code & Test Review",
        "Delegate to Gemini CLI via gemini-bridge.",
        "Gemini reviews: code quality, test coverage (build PRD-to-test matrix), TDD compliance, security.",
        ...(hasAuditSkill || hasWebDesignSkill ? [`For frontend: apply${hasAuditSkill ? " .ai/skills/impeccable/audit.md" : ""}${hasAuditSkill && hasWebDesignSkill ? " +" : ""}${hasWebDesignSkill ? " .ai/skills/vercel-web-design/web-design-guidelines.md" : ""}.`] : []),
        "Output findings as a structured list.",
        ""
      );
    } else {
      const model = reviewer === "sonnet" ? "sonnet" : "opus";
      parts.push(
        `### ${reviewer.charAt(0).toUpperCase() + reviewer.slice(1)} — Code & Test Review`,
        `Launch a sub-Agent with \`model: '${model}', isolation: 'worktree'\`.`,
        "Review: code quality (review-code.md), test coverage (review-test-coverage.md),",
        "TDD compliance, security.",
        ...(hasAuditSkill ? ["For frontend code: read and apply .ai/skills/impeccable/audit.md (aesthetic + anti-AI-slop audit),"] : []),
        ...(hasWebDesignSkill ? ["then .ai/skills/vercel-web-design/web-design-guidelines.md (engineering QA: a11y, performance, UX)."] : []),
        "Build a PRD-to-test coverage matrix — every PRD requirement MUST have a test.",
        "Return a structured findings list.",
        ""
      );
    }
  }

  parts.push(
    "### Adversarial Review (Fresh Context)",
    "Launch one additional sub-Agent (sonnet, worktree isolation) with NO access to checklists, PRD, or previous findings.",
    "Give it ONLY the source code and this instruction:",
    "\"You are an attacker and chaos engineer. Break this application. Focus on: malformed input, concurrency, external service failures, state corruption, privilege escalation, wrong assumptions. Report only findings with concrete attack scenarios.\"",
    "Include adversarial findings in the triage alongside structured review findings.",
    ""
  );

  parts.push(
    "## Step 2: Collect & Deduplicate",
    "",
    "After ALL reviewers complete:",
    "1. Collect findings from every reviewer",
    "2. Deduplicate — same issue from multiple reviewers counts as ONE",
    "3. Classify each unique finding:",
    "   - **BUG**: Behavior doesn't match PRD/acceptance criteria → MUST FIX",
    "   - **SECURITY**: Vulnerability or exposed secret → MUST FIX (P0)",
    "   - **COVERAGE GAP**: PRD requirement without test → MUST FIX",
    "   - **STYLE**: Formatting/naming only → SKIP",
    "   - **FALSE POSITIVE**: Reviewer misunderstood → SKIP with justification",
    "   - **ENHANCEMENT**: Good idea, out of scope → LOG in STATE.md",
    "",
    "## Step 3: Triage & Fix",
    "",
    "For each BUG/SECURITY/COVERAGE GAP:",
    "1. Create a fix task (add to dev/task.json with status todo, type: review)",
    "2. Dispatch a Sonnet or Codex sub-agent to fix it (with worktree isolation)",
    "3. After fix: verify the fix, merge, and mark task done",
    "",
    "## Step 4: Record & Converge",
    "",
    `Record this round's results in dev/review/FINAL-REVIEW-ROUND-${round}.md`,
    "Update dev/progress.txt with what was reviewed and fixed.",
    "Update .planning/STATE.md.",
    "Git commit all changes.",
    "",
    "## Convergence",
    ""
  );

  if (round >= maxRounds) {
    parts.push(
      `This is round ${round}/${maxRounds} (FINAL). After this round:`,
      "- Write ALL remaining unresolved issues to dev/review/FINAL-REVIEW-UNRESOLVED.md",
      "- Include a clear summary: how many issues remain, their severity breakdown (BUG/SECURITY/COVERAGE GAP)",
      "- Update STATE.md with status 'awaiting_user_decision' and the unresolved issue count",
      "- The autopilot will PAUSE and ask the user whether to continue or accept as-is",
      "- Do NOT start another review round — the user decides next steps"
    );
  } else {
    parts.push(
      `This is round ${round}/${maxRounds}.`,
      "If zero new BUG/SECURITY/COVERAGE GAP findings → the review has CONVERGED. Phase is complete.",
      "If there are new findings → fix them, and the autopilot will start the next review round automatically."
    );
  }

  parts.push(
    "",
    "## Available Review Tools",
    reviewToolsSection || "(none configured)",
    "",
    "## Deviation Rules",
    "Follow AGENTS.md deviation rules. If an issue is ambiguous (D4), classify as FALSE POSITIVE rather than creating a bad fix."
  );

  return parts.join("\n");
}

async function waitWithCountdown(minutes) {
  const totalSeconds = Math.max(1, minutes * 60);
  for (let elapsed = 0; elapsed < totalSeconds; elapsed += 1) {
    if (pathExists(".autopilot/.stop")) {
      return false;
    }
    const remaining = totalSeconds - elapsed;
    if (remaining % 30 === 0 || remaining === totalSeconds) {
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      console.log(`Waiting before retry: ${mins}m ${secs}s remaining`);
    }
    await sleep(1000);
  }
  return true;
}

async function waitForRetry({ fallbackMinutes, failureHint, retryAfterSeconds = null }) {
  // Prefer the structured retryAfterSeconds, then try to parse from text hint
  const parsedSeconds = retryAfterSeconds ?? parseQuotaResetWaitSeconds(failureHint);
  if (!parsedSeconds) {
    return waitWithCountdown(fallbackMinutes);
  }

  console.log(`Waiting until quota reset window: ${formatDuration(parsedSeconds)}`);
  const totalSeconds = Math.max(1, parsedSeconds);
  for (let elapsed = 0; elapsed < totalSeconds; elapsed += 1) {
    if (pathExists(".autopilot/.stop")) {
      return false;
    }
    const remaining = totalSeconds - elapsed;
    if (remaining % 30 === 0 || remaining === totalSeconds) {
      console.log(`Quota wait remaining: ${formatDuration(remaining)}`);
    }
    await sleep(1000);
  }
  return true;
}

function writeAssistantText(text, outputStream) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return;
  }

  console.log(normalized);
  outputStream.write(`${normalized}\n`);
}

/**
 * Attempt to parse structured error JSON from a single line of text.
 * Returns { category, retryAfterSeconds, source } if a quota/rate-limit error is
 * detected in a known structured format, otherwise returns null.
 *
 * Handled formats:
 *   - Claude API:  {"type":"error","error":{"type":"rate_limit_error","message":"..."}}
 *   - Generic HTTP: {"status":429,...} or {"statusCode":429,...}
 *   - Codex JSONL: {"type":"error","code":"rate_limit",...}
 */
function tryParseStructuredError(text) {
  const lines = String(text ?? "").split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Claude API format
    if (parsed?.type === "error" && parsed?.error?.type === "rate_limit_error") {
      const retryAfterSeconds = parsed.error?.retry_after ?? parsed.error?.reset_after ?? null;
      return {
        category: "quota",
        retryAfterSeconds: retryAfterSeconds != null ? Number(retryAfterSeconds) : null,
        source: "structured"
      };
    }

    // Generic HTTP status 429
    const httpStatus = parsed?.status ?? parsed?.statusCode;
    if (httpStatus === 429) {
      const retryAfterSeconds = parsed?.retry_after ?? parsed?.retryAfter ?? parsed?.reset_after ?? null;
      return {
        category: "quota",
        retryAfterSeconds: retryAfterSeconds != null ? Number(retryAfterSeconds) : null,
        source: "structured"
      };
    }

    // Codex JSONL error format
    if (parsed?.type === "error" && typeof parsed?.code === "string" && parsed.code.toLowerCase().includes("rate_limit")) {
      const retryAfterSeconds = parsed?.retry_after ?? parsed?.reset_after ?? null;
      return {
        category: "quota",
        retryAfterSeconds: retryAfterSeconds != null ? Number(retryAfterSeconds) : null,
        source: "structured"
      };
    }
  }

  return null;
}

/**
 * Improved text-based quota detection.
 * Uses word-boundary matching for keyword terms and restricts "429" to
 * contexts that look like HTTP status codes (not arbitrary occurrences of the
 * digit sequence).
 */
function detectFailureCategoryFromText(text) {
  const normalized = String(text ?? "");
  if (!normalized) {
    return null;
  }

  // Word-boundary patterns for quota-related terms (case-insensitive)
  const quotaPatterns = [
    /\brate[- ]limit(ed)?\b/iu,
    /\bquota\b/iu,
    /\busage[- ]limit\b/iu,
    /\bhit (your|the) limit\b/iu,
    /\bcredit[- ]balance\b/iu,
    /\btoo[- ]many[- ]requests\b/iu,
    // "429" only when it appears as an HTTP status code
    /\b429\b(?=\s*(too many|rate|quota|error|status|response))/iu,
    /(?:status|code|http)[:\s]+429\b/iu,
    /"status"\s*:\s*429\b/iu
  ];

  for (const pattern of quotaPatterns) {
    if (pattern.test(normalized)) {
      return { category: "quota", retryAfterSeconds: null, source: "text" };
    }
  }

  return null;
}

/**
 * Detect whether the given text signals a quota/rate-limit failure.
 * Tries structured JSON parsing first; falls back to text heuristics.
 *
 * Returns: { category: "quota"|null, retryAfterSeconds: number|null, source: "structured"|"text" }
 * or null when no failure category is detected.
 */
function detectFailureCategory(text) {
  if (!String(text ?? "").trim()) {
    return null;
  }

  const structured = tryParseStructuredError(text);
  if (structured) {
    return structured;
  }

  return detectFailureCategoryFromText(text);
}

function isMissingSessionError(text) {
  return /no conversation found with session id/iu.test(String(text ?? ""));
}

function extractCodexText(item = {}) {
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text;
  }

  if (typeof item.message === "string" && item.message.trim()) {
    return item.message;
  }

  if (Array.isArray(item.content)) {
    return item.content
      .filter((block) => block?.type === "output_text" || block?.type === "text")
      .map((block) => block.text ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return "";
}

function extractCodexToolLabel(item = {}) {
  return item.command ?? item.cmd ?? item.description ?? item.title ?? "";
}

function handleRunnerLine({ runner, line, outputStream, currentSessionId, usageAccum }) {
  try {
    const event = JSON.parse(line);
    let nextSessionId = currentSessionId;

    if (event.session_id) {
      nextSessionId = event.session_id;
    }
    if (event.thread_id) {
      nextSessionId = event.thread_id;
    }

    if (runner.outputParser === "claude-stream-json") {
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            writeAssistantText(block.text, outputStream);
          }
          if (block.type === "tool_use" && block.name) {
            console.log(`[tool] ${block.name}`);
          }
        }
      }

      if (event.type === "tool_result") {
        console.log("[tool done]");
      }

      if (event.type === "result") {
        console.log(
          `[done] turns=${event.num_turns ?? "?"} cost=${event.total_cost_usd ?? "n/a"} session=${nextSessionId}`
        );
        // Capture cost and token usage from Claude result event
        if (usageAccum && event.total_cost_usd != null) {
          usageAccum.costUsd = Number(event.total_cost_usd) || 0;
        }
        if (usageAccum && event.usage) {
          usageAccum.inputTokens = Number(event.usage.input_tokens) || 0;
          usageAccum.outputTokens = Number(event.usage.output_tokens) || 0;
        }
      }

      return nextSessionId;
    }

    if (runner.outputParser === "codex-jsonl") {
      if (event.type === "thread.started") {
        console.log(`[session] ${nextSessionId}`);
      }

      if (event.type === "item.started" && event.item?.type === "command_execution") {
        const label = extractCodexToolLabel(event.item);
        if (label) {
          console.log(`[tool] ${label}`);
        }
      }

      if (event.type === "item.completed") {
        if (event.item?.type === "agent_message") {
          writeAssistantText(extractCodexText(event.item), outputStream);
        } else if (event.item?.type === "command_execution") {
          console.log("[tool done]");
        }
      }

      if (event.type === "turn.completed") {
        const usage = event.usage ?? {};
        console.log(
          `[done] input=${usage.input_tokens ?? "?"} output=${usage.output_tokens ?? "?"} session=${nextSessionId}`
        );
        // Capture token usage from Codex turn.completed event
        if (usageAccum) {
          usageAccum.inputTokens = Number(usage.input_tokens) || 0;
          usageAccum.outputTokens = Number(usage.output_tokens) || 0;
        }
      }

      if (event.type === "error" && event.message) {
        console.error(event.message);
      }

      return nextSessionId;
    }

    if (event.message) {
      writeAssistantText(event.message, outputStream);
      return nextSessionId;
    }
  } catch {
    if (line.trim()) {
      writeAssistantText(line, outputStream);
    }
  }

  return currentSessionId;
}

/**
 * Spawn the configured AI runner as a child process, stream its output,
 * detect quota/failure signals, and return the result.
 * Handles session resume, timeout (SIGTERM → SIGKILL), and missing-session fallback.
 * @param {object} options
 * @param {string} options.prompt - The prompt to send
 * @param {string} options.model - Model identifier
 * @param {object} options.config - Autopilot configuration
 * @param {object} options.state - Current autopilot state
 * @param {string|null} options.taskId - Current task ID or null for idle
 * @param {boolean} options.allowResumeFallback - Whether to retry with fresh session on missing session
 * @returns {Promise<{exitCode: number, sessionId: string, failureCategory?: string, retryAfterSeconds?: number, failureHint?: string, inputTokens: number, outputTokens: number, costUsd: number}>}
 */
async function invokeRunner({ prompt, model, config, state, taskId, allowResumeFallback = true }) {
  ensureDir(".autopilot/logs");
  const runner = resolveRunnerProfile(config);
  const runnerCommand = getExecutable(runner.command);
  const sessionId = state.sessionId || randomUUID();
  const shouldResume = runner.supportsResume && !!state.sessionId && !isDryRun;
  const argsTemplate = shouldResume ? runner.resumeSessionArgs : runner.newSessionArgs;
  const args = fillTemplateArgs(argsTemplate, {
    prompt,
    model,
    sessionId,
    permissionMode: runner.permissionMode ?? "",
    sandboxMode: runner.sandboxMode ?? "",
    cwd: process.cwd()
  });

  appendFileSync(".autopilot/logs/autopilot.log", `\n===== ${new Date().toISOString()} =====\n`, "utf8");
  appendFileSync(
    ".autopilot/logs/autopilot.log",
    `Round task=${taskId ?? "idle"} runner=${runner.mode} model=${model} session=${state.sessionId || sessionId}\n`,
    "utf8"
  );

  if (isDryRun) {
    console.log("");
    console.log(`[DRY RUN] ${runner.displayName} would be invoked with:`);
    console.log(`${runnerCommand} ${args.join(" ")}`);
    console.log("");
    console.log("[DRY RUN] Prompt preview:");
    console.log(prompt);
    return {
      exitCode: 0,
      sessionId: state.sessionId || "",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0
    };
  }

  const logStream = createWriteStream(".autopilot/logs/autopilot.log", { flags: "a" });
  // Each invokeRunner call overwrites this file so STATUS parsing only sees the current task's output.
  // If this is a retry (e.g. missingSessionDetected), the previous attempt's output is lost — check autopilot.log for full history.
  const outputStream = createWriteStream(".autopilot/logs/assistant-output.log", { flags: "w" });
  /** Mutable accumulator for usage metrics captured from streamed events */
  const usageAccum = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  const child = requiresCommandShell(runnerCommand) && runner.promptTransport === "stdin"
    ? spawn(buildShellCommandLine(runnerCommand, args), {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: true
      })
    : spawn(runnerCommand, args, {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: requiresCommandShell(runnerCommand)
      });

  if (runner.promptTransport === "stdin") {
    child.stdin.write(prompt);
  }
  child.stdin.end();

  let resolvedSessionId = state.sessionId || sessionId;
  let lastOutputAt = Date.now();
  let spawnError = null;
  /** @type {{ category: string|null, retryAfterSeconds: number|null, source: string }|null} */
  let failureDetection = null;
  let failureHint = "";
  let missingSessionDetected = false;
  let timedOut = false;
  const heartbeat = setInterval(() => {
    const idleSeconds = Math.floor((Date.now() - lastOutputAt) / 1000);
    console.log(`[working] AI is still processing... idle ${idleSeconds}s`);
  }, Math.max(5, config.loop.heartbeatSeconds ?? 10) * 1000);

  const taskTimeoutSeconds = config.loop.taskTimeoutSeconds ?? 1800;
  let sigkillTimer = null;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    console.error(`[timeout] Task exceeded ${taskTimeoutSeconds}s limit. Terminating child process tree.`);
    if (process.platform === "win32" && child.pid) {
      // On Windows, child.kill() only kills the wrapper (cmd.exe), not grandchildren.
      // Use taskkill /T (tree) to kill the entire process tree.
      try {
        spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", timeout: 5000 });
      } catch { /* best-effort */ }
    } else {
      child.kill("SIGTERM");
    }
    sigkillTimer = setTimeout(() => {
      if (!child.killed) {
        console.error("[timeout] Child did not exit after termination signal. Force-killing.");
        if (process.platform === "win32" && child.pid) {
          try {
            spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", timeout: 5000 });
          } catch { /* best-effort */ }
        } else {
          child.kill("SIGKILL");
        }
      }
    }, 5000);
  }, taskTimeoutSeconds * 1000);

  const outputReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  outputReader.on("line", (line) => {
    lastOutputAt = Date.now();
    logStream.write(`${line}\n`);
    const lineDetection = detectFailureCategory(line);
    if (lineDetection) {
      // Prefer structured detections with retryAfterSeconds over earlier matches
      if (!failureDetection || (lineDetection.retryAfterSeconds != null && failureDetection.retryAfterSeconds == null)) {
        failureDetection = lineDetection;
        failureHint = line.trim();
      }
    }
    if (isMissingSessionError(line)) {
      missingSessionDetected = true;
      if (!failureHint) {
        failureHint = line.trim();
      }
    }
    resolvedSessionId = handleRunnerLine({
      runner,
      line,
      outputStream,
      currentSessionId: resolvedSessionId,
      usageAccum
    });
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    logStream.write(text);
    const stderrDetection = detectFailureCategory(text);
    if (stderrDetection) {
      if (!failureDetection || (stderrDetection.retryAfterSeconds != null && failureDetection.retryAfterSeconds == null)) {
        failureDetection = stderrDetection;
        failureHint = text.trim();
      }
    }
    if (isMissingSessionError(text)) {
      missingSessionDetected = true;
      if (!failureHint) {
        failureHint = text.trim();
      }
    }
    if (text.trim()) {
      console.error(text.trim());
    }
  });

  child.on("error", (error) => {
    spawnError = error;
    const text = String(error.message ?? error);
    logStream.write(`${text}\n`);
    const errorDetection = detectFailureCategory(text);
    if (errorDetection) {
      if (!failureDetection || (errorDetection.retryAfterSeconds != null && failureDetection.retryAfterSeconds == null)) {
        failureDetection = errorDetection;
        failureHint = text.trim();
      }
    }
    if (isMissingSessionError(text)) {
      missingSessionDetected = true;
      if (!failureHint) {
        failureHint = text.trim();
      }
    }
    console.error(text);
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", (code) => {
      resolve(spawnError ? 1 : (code ?? 1));
    });
  });

  clearTimeout(timeoutHandle);
  if (sigkillTimer) {
    clearTimeout(sigkillTimer);
  }
  clearInterval(heartbeat);
  await new Promise((resolve) => { logStream.end(resolve); })
    .catch(() => { /* log file is best-effort */ });
  await new Promise((resolve, reject) => {
    outputStream.on("finish", resolve);
    outputStream.on("error", reject);
    outputStream.end();
  }).catch(() => { /* ignore write errors — log file is best-effort */ });

  if (timedOut) {
    return {
      exitCode,
      sessionId: resolvedSessionId,
      failureCategory: "timeout",
      failureHint: `Task execution timed out after ${taskTimeoutSeconds}s`,
      inputTokens: usageAccum.inputTokens,
      outputTokens: usageAccum.outputTokens,
      costUsd: usageAccum.costUsd
    };
  }

  if (missingSessionDetected && shouldResume && allowResumeFallback) {
    console.log("Saved AI session was not found. Starting a fresh session instead.");
    return invokeRunner({
      prompt,
      model,
      config,
      state: {
        ...state,
        sessionId: ""
      },
      taskId,
      allowResumeFallback: false
    });
  }

  return {
    exitCode,
    sessionId: resolvedSessionId,
    failureCategory: failureDetection?.category ?? null,
    retryAfterSeconds: failureDetection?.retryAfterSeconds ?? null,
    failureHint,
    inputTokens: usageAccum.inputTokens,
    outputTokens: usageAccum.outputTokens,
    costUsd: usageAccum.costUsd
  };
}

/**
 * Append a task's metrics to dev/metrics.json.
 * Reads the current file (or creates it), finds or creates the current session entry,
 * appends the task record, updates totals, and writes back atomically.
 *
 * @param {object} opts
 * @param {string} opts.sessionId - UUID for the current autopilot session
 * @param {string} opts.sessionStartedAt - ISO timestamp when the session started
 * @param {string} opts.taskId - Task ID (e.g. "T001") or "idle" / "final-review-N"
 * @param {string} opts.model - Model identifier used for this task
 * @param {string} opts.startedAt - ISO timestamp when the task invocation began
 * @param {string} opts.completedAt - ISO timestamp when the task invocation ended
 * @param {number} opts.durationMs - Wall-clock duration in milliseconds
 * @param {number} opts.inputTokens - Input tokens consumed
 * @param {number} opts.outputTokens - Output tokens consumed
 * @param {number} opts.costUsd - Cost in USD
 * @param {string} opts.status - "success" | "failed" | "quota_wait" | "timeout"
 */
function recordTaskMetrics({ sessionId, sessionStartedAt, taskId, model, startedAt, completedAt, durationMs, inputTokens, outputTokens, costUsd, status }) {
  ensureDir("dev");
  const metricsPath = "dev/metrics.json";
  const data = readJson(metricsPath, { sessions: [] });

  if (!Array.isArray(data.sessions)) {
    data.sessions = [];
  }

  // Find or create the current session entry
  let session = data.sessions.find((s) => s.session_id === sessionId);
  if (!session) {
    session = {
      session_id: sessionId,
      started_at: sessionStartedAt,
      tasks: [],
      totals: {
        tasks_completed: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_usd: 0,
        total_duration_ms: 0
      }
    };
    data.sessions.push(session);
  }

  // Append task entry
  session.tasks.push({
    task_id: taskId,
    model,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
    status
  });

  // Recompute session totals from all tasks
  const totals = {
    tasks_completed: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0,
    total_duration_ms: 0
  };
  for (const t of session.tasks) {
    if (t.status === "success") {
      totals.tasks_completed += 1;
    }
    totals.total_input_tokens += t.input_tokens ?? 0;
    totals.total_output_tokens += t.output_tokens ?? 0;
    totals.total_cost_usd += t.cost_usd ?? 0;
    totals.total_duration_ms += t.duration_ms ?? 0;
  }
  // Round cost to avoid floating-point drift
  totals.total_cost_usd = Math.round(totals.total_cost_usd * 1e8) / 1e8;
  session.totals = totals;

  try {
    writeJson(metricsPath, data);
  } catch (err) {
    // Non-fatal: metrics write failure should never crash the autopilot
    console.warn(`[metrics] Failed to write dev/metrics.json: ${err.message}`);
  }
}

async function main() {
  const config = loadConfig();
  const runner = resolveRunnerProfile(config);

  if (runner.mode === "claude" && process.env.CLAUDECODE) {
    console.error("Autopilot must be started outside an existing Claude Code session. — close the current Claude Code session and run `pnpm work` from a plain terminal");
    process.exit(1);
  }

  const probe = probeRunner(config);
  if (!probe.passed) {
    console.error(`Configured runner is not ready: ${renderRunnerSummary(config)} — run \`pnpm autopilot:configure\` to set up a working AI runtime`);
    if (probe.validationIssues.length > 0) {
      for (const issue of probe.validationIssues) {
        console.error(`- ${issue}`);
      }
    }
    if (probe.probeError) {
      console.error(probe.probeError);
    }
    console.error("Run pnpm autopilot:doctor or pnpm autopilot:configure for details.");
    process.exit(1);
  }

  clearStopSignal();

  const metricsSessionId = randomUUID();
  const metricsSessionStartedAt = new Date().toISOString();

  const state = loadState();

  // Handle user decision after review pause or task needing context
  if (state.status === "awaiting_user_decision") {
    const pauseReason = state.needsContextDetails ? "needs_context" : "review_max_rounds";
    if (pauseReason === "needs_context" && !acceptAsIs) {
      if (continueReview) {
        // --continue-review is not applicable to needs_context, treat as resume
        console.log("Resuming after context was provided...");
        saveState({ ...state, status: "running", needsContextDetails: undefined });
      } else {
        // No flags — check if the task is still in 'awaiting' state or user already provided context
        // Since there's no way to programmatically detect context was provided,
        // resume and let the task re-run (the agent will either succeed or NEEDS_CONTEXT again)
        console.log("");
        console.log("Autopilot is paused — a task needs additional context.");
        console.log(`Task: ${state.lastTaskId}`);
        console.log(`Details: ${state.needsContextDetails}`);
        console.log("");
        console.log("Options:");
        console.log("  pnpm work --continue-review  → resume the task (after providing context)");
        console.log("  pnpm work --accept-as-is     → skip this task and continue");
        console.log("");
        process.exit(0);
      }
    }
    if (acceptAsIs) {
      if (pauseReason === "needs_context") {
        console.log("Skipping blocked task and continuing.");
        // Mark the task as skipped
        const allTasks = readJson("dev/task.json", { tasks: [] });
        const skippedTask = (allTasks.tasks ?? []).find((t) => t.id === state.lastTaskId);
        if (skippedTask) {
          skippedTask.status = "skipped";
          writeJson("dev/task.json", allTasks);
        }
        saveState({ ...state, status: "running", needsContextDetails: undefined });
      } else {
        console.log("User accepted current state as-is. Marking review as done.");
        saveState({ ...state, status: "final_review_done" });
        pushToRemote();
        process.exit(0);
      }
    } else if (continueReview) {
      // Grant additional rounds (same as computed max, effectively doubles the budget)
      const planConfig = readJson(".planning/config.json", {});
      const currentRound = state.finalReviewRound ?? 0;
      const additionalRounds = computeMaxReviewRounds({
        taskCount: getTasks().length,
        sourceFileCount: countSourceFiles(),
        configMaxRounds: planConfig?.final_review?.max_rounds,
        reviewStrategy: planConfig?.review_strategy
      });
      const newMax = currentRound + additionalRounds;
      console.log(`Extending review: ${additionalRounds} more rounds (new max: ${newMax}).`);
      // Store extended max in state (runtime only) — do NOT write to config.json
      // to avoid permanently inflating max_rounds across sessions
      saveState({ ...state, status: "final_review", finalReviewRound: currentRound, sessionMaxRounds: newMax });
      console.log("Resuming review...");
    } else {
      console.log("");
      console.log("Autopilot is paused — awaiting your decision.");
      console.log("Unresolved issues: dev/review/FINAL-REVIEW-UNRESOLVED.md");
      console.log("");
      console.log("Options:");
      console.log("  pnpm work --continue-review  → extend review rounds");
      console.log("  pnpm work --accept-as-is     → accept current state and finish");
      console.log("");
      process.exit(0);
    }
  }

  saveState({ ...loadState(), status: "starting" });
  invalidateStateCache();

  process.on("SIGINT", () => {
    notify("stopped", { reason: "SIGINT (user interrupt)" }).catch?.(() => {});
    saveState({ ...loadState(), status: "stopped" });
    process.exit(130);
  });

  const taskRetryMap = new Map();
  let unavailableCliPollCount = 0;
  const MAX_UNAVAILABLE_CLI_POLLS = 10;

  while (true) {
    // Invalidate cached state at the start of each iteration so we pick up
    // any external modifications (e.g. user editing state.json).
    invalidateStateCache();

    if (pathExists(".autopilot/.stop")) {
      saveState({ ...loadState(), status: "stopped" });
      notify("stopped", { reason: "stop signal detected" }).catch?.(() => {});
      console.log("Stop signal detected. Autopilot is stopping.");
      break;
    }

    const currentState = loadState();
    let readyTasks = getReadyTasks();

    // Pre-flight: if any ready task needs codex, verify prerequisites — skip codex tasks if not available (#R4-3)
    const hasCodexTasks = readyTasks.some(t => t.assignee === "codex");
    const codexCheck = hasCodexTasks ? checkCodexPrerequisites() : { available: true, issues: [] };
    if (!codexCheck.available) {
      const codexTasks = readyTasks.filter((t) => t.assignee === "codex");
      if (codexTasks.length > 0) {
        console.warn(`[autopilot] Codex prerequisites missing — skipping ${codexTasks.length} codex-assigned task(s) — install codex CLI or reassign tasks to sonnet in dev/task.json`);
        for (const issue of codexCheck.issues) console.warn(`  - ${issue}`);
        for (const ct of codexTasks) console.warn(`  - Skipped: ${ct.id} (${ct.name})`);
        readyTasks = readyTasks.filter((t) => t.assignee !== "codex");
      }
    }

    // Pre-flight: if any ready task needs gemini, verify prerequisites — skip gemini tasks if not available
    const hasGeminiTasks = readyTasks.some(t => t.assignee === "gemini");
    const geminiCheck = hasGeminiTasks ? checkGeminiPrerequisites() : { available: true, issues: [] };
    if (!geminiCheck.available) {
      const geminiTasks = readyTasks.filter((t) => t.assignee === "gemini");
      if (geminiTasks.length > 0) {
        console.warn(`[autopilot] Gemini prerequisites missing — skipping ${geminiTasks.length} gemini-assigned task(s) — install gemini CLI or reassign tasks to sonnet in dev/task.json`);
        for (const issue of geminiCheck.issues) console.warn(`  - ${issue}`);
        for (const gt of geminiTasks) console.warn(`  - Skipped: ${gt.id} (${gt.name})`);
        readyTasks = readyTasks.filter((t) => t.assignee !== "gemini");
      }
    }

    if (readyTasks.length === 0) {
      const originalReady = getReadyTasks();
      if (originalReady.length > 0) {
        unavailableCliPollCount++;
        if (unavailableCliPollCount >= MAX_UNAVAILABLE_CLI_POLLS) {
          console.error(`[autopilot] All remaining tasks require unavailable CLIs. Reassign tasks or install the required CLI. Autopilot stopping.`);
          saveState({ ...loadState(), status: "blocked" });
          break;
        }
        console.warn(`[autopilot] All ready tasks require unavailable CLI tools (attempt ${unavailableCliPollCount}/${MAX_UNAVAILABLE_CLI_POLLS}). Waiting for next round. — install the required CLI tool or reassign the task to an available runner`);
        if (runOnce) break;
        await waitWithCountdown(1);
        continue;
      }
    }
    // Reset counter once tasks are available through normal runners
    unavailableCliPollCount = 0;

    // Compute task/model/prompt AFTER codex/gemini filtering so they reflect the actual work
    const task = readyTasks.length > 0 ? readyTasks[0] : null;
    const model = resolveModel(task, config);
    const prompt = buildPrompt(readyTasks, config);

    // Log which skills were injected for this task
    if (task) {
      const registry = readJson(".ai/skills/skill-registry.json", null);
      if (registry?.skills) {
        const injectedSkillIds = [];
        for (const [moduleId, mod] of Object.entries(registry.skills)) {
          for (const [skillName, skillDef] of Object.entries(mod.skills || {})) {
            const skillId = `${moduleId}/${skillName}`;
            if (skillDef.file && prompt.includes(skillDef.file)) {
              injectedSkillIds.push(skillId);
            }
          }
        }
        if (injectedSkillIds.length > 0) {
          appendFileSync(
            "dev/progress.txt",
            `[SKILLS] Task ${task.id}: injected ${injectedSkillIds.length} skills (${injectedSkillIds.join(", ")})\n`,
            "utf8"
          );
        }
      }
    }

    saveState({
      ...currentState,
      status: "running",
      round: (currentState.round ?? 0) + 1,
      lastTaskId: task?.id ?? null
    });

    console.log("");
    console.log(`Autopilot round ${loadState().round}`);
    console.log(`Mode: ${task ? `task ${task.id}` : "idle planning"}`);
    if (task?.assignee === "codex") {
      console.log(`Assignee: codex (delegation via Opus prompt)`);
    } else if (task?.assignee === "gemini") {
      console.log(`Assignee: gemini (delegation via Opus prompt)`);
    } else if (task?.assignee) {
      console.log(`Assignee: ${task.assignee}`);
    }
    console.log(`Runner: ${renderRunnerSummary(config)}`);
    console.log(`Model: ${model}`);

    const taskStartTime = Date.now();
    const taskStartedAt = new Date(taskStartTime).toISOString();

    const result = await invokeRunner({
      prompt,
      model,
      config,
      state: loadState(),
      taskId: task?.id ?? null
    });

    const taskEndTime = Date.now();
    const taskCompletedAt = new Date(taskEndTime).toISOString();
    const taskDurationMs = taskEndTime - taskStartTime;

    // Record metrics for this invocation (success or failure)
    const taskMetricsStatus = result.exitCode === 0
      ? "success"
      : result.failureCategory === "quota"
        ? "quota_wait"
        : result.failureCategory === "timeout"
          ? "timeout"
          : "failed";

    recordTaskMetrics({
      sessionId: metricsSessionId,
      sessionStartedAt: metricsSessionStartedAt,
      taskId: task?.id ?? "idle",
      model,
      startedAt: taskStartedAt,
      completedAt: taskCompletedAt,
      durationMs: taskDurationMs,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      costUsd: result.costUsd ?? 0,
      status: taskMetricsStatus
    });

    // Notify on task completion or failure (non-blocking)
    if (result.exitCode === 0 && task) {
      // Parse agent completion status protocol — read from assistant output log
      // since invokeRunner does not return an output field
      let agentOutput = "";
      try {
        const fullOutput = readFileSync(".autopilot/logs/assistant-output.log", "utf8");
        const outputLines = fullOutput.split(/\r?\n/);
        agentOutput = outputLines.slice(-20).join("\n");
      } catch { /* file may not exist */ }
      const completionStatus = parseCompletionStatus(agentOutput);
      if (!completionStatus.raw) {
        console.warn("⚠ Agent did not emit completion status — treating as DONE");
      }
      if (completionStatus.status === "BLOCKED") {
        console.error(`Task blocked: ${completionStatus.details} — check task dependencies in dev/task.json or reassign blocked tasks`);
        // Mark the task as "blocked" in task.json so it won't be picked again
        const allTasks = readJson("dev/task.json", { tasks: [] });
        const blockedTask = (allTasks.tasks ?? []).find((t) => t.id === task.id);
        if (blockedTask) {
          blockedTask.status = "blocked";
          writeJson("dev/task.json", allTasks);
        }
        appendProgressEntry(`Task ${task.id} BLOCKED: ${completionStatus.details}`);
        saveState({
          ...loadState(),
          status: "running",
          lastTaskId: task.id,
          lastFailureCategory: "blocked",
          lastFailureHint: completionStatus.details
        });
        if (runOnce) break;
        continue;
      }
      if (completionStatus.status === "NEEDS_CONTEXT") {
        console.warn(`Task needs context: ${completionStatus.details} — autopilot pausing for user input`);
        appendProgressEntry(`Task ${task.id} NEEDS_CONTEXT: ${completionStatus.details}`);
        saveState({
          ...loadState(),
          status: "awaiting_user_decision",
          lastTaskId: task.id,
          needsContextDetails: completionStatus.details
        });
        notify("awaiting_user_decision", {
          task_id: task.id,
          task_name: task.name,
          reason: "needs_context",
          details: completionStatus.details
        }).catch?.(() => {});
        break;
      }
      if (completionStatus.status === "DONE_WITH_CONCERNS") {
        appendProgressEntry(`Task ${task.id} completed with concerns: ${completionStatus.details}`);
      }

      notify("task_completed", {
        task_id: task.id,
        task_name: task.name,
        duration: formatDuration(taskDurationMs / 1000),
        cost: result.costUsd ?? 0
      }).catch?.(() => {});

      // Post-task git safety net: auto-commit any uncommitted changes
      ensureCleanWorkingTree(task.id, task.name);
    }

    if (result.failureCategory === "timeout") {
      const taskId = task?.id ?? null;
      const maxTaskRetries = config.loop.maxTaskRetries ?? 2;
      const currentTaskRetries = taskId ? (taskRetryMap.get(taskId) ?? 0) : maxTaskRetries;
      const nextTaskRetries = currentTaskRetries + 1;

      saveState({
        ...loadState(),
        status: "waiting_retry",
        sessionId: result.sessionId,
        lastExitCode: result.exitCode,
        lastFailureCategory: result.failureCategory,
        lastFailureHint: result.failureHint ?? ""
      });

      if (taskId && nextTaskRetries <= maxTaskRetries) {
        taskRetryMap.set(taskId, nextTaskRetries);
        console.log(
          `Task ${taskId} timed out (attempt ${nextTaskRetries}/${maxTaskRetries}). Re-queuing for retry.`
        );
      } else {
        if (taskId) {
          taskRetryMap.set(taskId, nextTaskRetries);
        }
        console.error(
          `Task ${taskId ?? "(idle)"} timed out and exceeded max task retries (${maxTaskRetries}). Marking as failed and moving on. — consider breaking the task into smaller subtasks in dev/task.json or increasing timeout in .autopilot/config.json`
        );
        if (taskId) {
          const allTasks = readJson("dev/task.json", { tasks: [] });
          const failedTask = (allTasks.tasks ?? []).find((t) => t.id === taskId);
          if (failedTask) {
            failedTask.status = "failed";
            writeJson("dev/task.json", allTasks);
          }
        }
        notify("task_failed", {
          task_id: taskId ?? "idle",
          error: result.failureHint ?? "timeout",
          retry_count: nextTaskRetries
        }).catch?.(() => {});
        appendFileSync(
          ".autopilot/logs/autopilot.log",
          `[timeout-skip] task=${taskId ?? "idle"} retries=${nextTaskRetries} hint=${result.failureHint ?? ""}\n`,
          "utf8"
        );
        if (runOnce) {
          break;
        }
        continue;
      }

      if (runOnce) {
        break;
      }
      continue;
    }

    const previousRetryCount = loadState().retryCount ?? 0;
    const nextRetryCount = result.exitCode === 0
      ? 0
      : result.failureCategory === "quota"
        ? previousRetryCount
        : previousRetryCount + 1;

    saveState({
      ...loadState(),
      status: result.exitCode === 0
        ? "idle"
        : result.failureCategory === "quota"
          ? "waiting_quota"
          : "waiting_retry",
      sessionId: result.sessionId,
      lastExitCode: result.exitCode,
      retryCount: nextRetryCount,
      lastFailureCategory: result.failureCategory ?? null,
      lastFailureHint: result.failureHint ?? ""
    });

    if (result.exitCode === 0) {
      const readyCheck = getReadyTasks();
      const finalSummary = getTaskProgressSummary();

      if (readyCheck.length === 0) {
        if (finalSummary.done + finalSummary.skipped + finalSummary.failed >= finalSummary.total && finalSummary.total > 0) {
          // --- Final Iteration Review Phase ---
          const planConfig = readJson(".planning/config.json", {});
          const finalReviewEnabled = planConfig?.final_review?.enabled ?? false;
          const currentStatus = loadState().status;

          if (finalReviewEnabled && currentStatus !== "final_review_done" && currentStatus !== "awaiting_user_decision") {
            const reviewStrategy = planConfig?.review_strategy;
            // Use sessionMaxRounds from state if set by --continue-review, otherwise compute
            const stateMaxRounds = loadState().sessionMaxRounds;
            const maxRounds = stateMaxRounds ?? computeMaxReviewRounds({
              taskCount: finalSummary.total,
              sourceFileCount: countSourceFiles(),
              configMaxRounds: planConfig.final_review.max_rounds,
              reviewStrategy
            });
            let reviewRound = loadState().finalReviewRound ?? 0;

            if (reviewRound >= maxRounds) {
              // Max rounds reached — check if unresolved issues exist
              const unresolvedPath = "dev/review/FINAL-REVIEW-UNRESOLVED.md";
              const unresolvedContent = readText(unresolvedPath, "");
              const hasUnresolved = unresolvedContent.trim().length > 0;

              if (hasUnresolved) {
                // Gather context for standardized question format
                let branchName = "unknown";
                try { branchName = execSync("git rev-parse --abbrev-ref HEAD", { timeout: 5000, stdio: "pipe" }).toString().trim(); } catch { /* ignore */ }
                const projectName = planConfig?.project_name ?? path.basename(rootDir);
                // Count unresolved issues (rough: count lines starting with - or *)
                const unresolvedLines = unresolvedContent.split("\n").filter(l => /^\s*[-*]\s/.test(l));
                const unresolvedCount = unresolvedLines.length || "unknown number of";
                const hasCritical = /\b(BUG|SECURITY)\b/.test(unresolvedContent);

                console.log("");
                console.log("╔══════════════════════════════════════════════════════════╗");
                console.log("║  REVIEW PAUSED — Awaiting User Decision                 ║");
                console.log("╠══════════════════════════════════════════════════════════╣");
                console.log(`║  Context: ${branchName} / ${projectName} / final review round ${reviewRound}`);
                console.log(`║  Question: ${unresolvedCount} unresolved issues remain after ${reviewRound} review rounds. How should we proceed?`);
                console.log(`║  Recommendation: ${hasCritical ? "Continue review — issues include BUG/SECURITY severity (confidence: 75%)" : "Accept as-is — no critical severity issues remain (confidence: 70%)"}`);
                console.log("║  Options:");
                console.log("║    1. pnpm work --continue-review — extend with another batch of review rounds (~15-30 min)");
                console.log("║    2. pnpm work --accept-as-is — accept current state and mark review complete (~0 min)");
                console.log("║  Details: dev/review/FINAL-REVIEW-UNRESOLVED.md");
                console.log("╚══════════════════════════════════════════════════════════╝");
                console.log("");
                saveState({ ...loadState(), status: "awaiting_user_decision" });
                notify("awaiting_user_decision", {
                  unresolved_issues: "dev/review/FINAL-REVIEW-UNRESOLVED.md",
                  review_rounds_completed: reviewRound,
                  options: ["pnpm work --continue-review", "pnpm work --accept-as-is"]
                }).catch?.(() => {});
                break;
              }

              console.log(`Final review completed after ${reviewRound} rounds — no unresolved issues. (${finalSummary.done}/${finalSummary.total})`);
              saveState({ ...loadState(), status: "final_review_done" });
              pushToRemote();
              break;
            }

            reviewRound += 1;
            console.log("");
            console.log(`=== FINAL ITERATION REVIEW — Round ${reviewRound}/${maxRounds} ===`);
            notify("final_review_started", {
              round_number: reviewRound,
              max_rounds: maxRounds
            }).catch?.(() => {});

            const previousFindingsPath = `dev/review/FINAL-REVIEW-ROUND-${reviewRound - 1}.md`;
            const previousFindings = reviewRound > 1 ? readText(previousFindingsPath, null) : null;

            // For final review, check CLI availability independently of task assignment
            // (all tasks are DONE so hasCodexTasks/hasGeminiTasks are always false)
            const finalCodexCheck = checkCodexPrerequisites();
            const finalGeminiCheck = checkGeminiPrerequisites();

            const reviewPrompt = buildFinalReviewPrompt(config, reviewRound, previousFindings, {
              codexAvailable: finalCodexCheck.available,
              geminiAvailable: finalGeminiCheck.available
            });
            const reviewModel = config.models.planning;

            saveState({
              ...loadState(),
              status: "final_review",
              finalReviewRound: reviewRound,
              round: (loadState().round ?? 0) + 1
            });

            console.log(`Runner: ${renderRunnerSummary(config)}`);
            console.log(`Model: ${reviewModel}`);

            const reviewStartTime = Date.now();
            const reviewStartedAt = new Date(reviewStartTime).toISOString();

            const reviewResult = await invokeRunner({
              prompt: reviewPrompt,
              model: reviewModel,
              config,
              state: loadState(),
              taskId: `final-review-${reviewRound}`
            });

            const reviewEndTime = Date.now();
            recordTaskMetrics({
              sessionId: metricsSessionId,
              sessionStartedAt: metricsSessionStartedAt,
              taskId: `final-review-${reviewRound}`,
              model: reviewModel,
              startedAt: reviewStartedAt,
              completedAt: new Date(reviewEndTime).toISOString(),
              durationMs: reviewEndTime - reviewStartTime,
              inputTokens: reviewResult.inputTokens ?? 0,
              outputTokens: reviewResult.outputTokens ?? 0,
              costUsd: reviewResult.costUsd ?? 0,
              status: reviewResult.exitCode === 0 ? "success" : reviewResult.failureCategory === "quota" ? "quota_wait" : "failed"
            });

            if (reviewResult.exitCode === 0) {
              // Check if new fix tasks were created (tasks went from all-done to some-todo)
              const postReviewTasks = getTasks();
              const newTodoTasks = postReviewTasks.filter((t) => t.status === "todo");

              if (newTodoTasks.length > 0) {
                // zero_bug mode: check if remaining bugs are below threshold
                if (reviewStrategy?.mode === "zero_bug") {
                  const threshold = reviewStrategy.zero_bug_threshold ?? 3;
                  if (newTodoTasks.length < threshold) {
                    console.log(`Review round ${reviewRound}: ${newTodoTasks.length} issue(s) remain (below zero_bug threshold ${threshold}). CONVERGED.`);
                    saveState({ ...loadState(), status: "final_review_done" });
                    pushToRemote();
                    break;
                  }
                }

                console.log(`Review round ${reviewRound} created ${newTodoTasks.length} fix task(s). Executing fixes before next review.`);
                // Let the main loop pick up fix tasks naturally
                if (runOnce) break;
                continue;
              }

              // No new tasks = converged or max rounds
              if (reviewRound >= maxRounds) {
                console.log(`Final review completed after ${reviewRound} rounds (max reached).`);
                saveState({ ...loadState(), status: "final_review_done" });
                pushToRemote();
                break;
              }

              console.log(`Review round ${reviewRound} found no new issues. Review CONVERGED.`);
              notify("final_review_done", {
                rounds_taken: reviewRound,
                issues_found: 0
              }).catch?.(() => {});
              saveState({ ...loadState(), status: "final_review_done" });
              pushToRemote();
              break;
            }

            // Review round failed (quota, error, etc.) — handle via normal retry logic
            if (reviewResult.failureCategory === "quota") {
              console.log("Quota hit during final review. Will retry after wait.");
            }

            // Fall through to normal error handling below (merge quota round-decrement into single saveState)
            saveState({
              ...loadState(),
              status: reviewResult.failureCategory === "quota" ? "waiting_quota" : "waiting_retry",
              sessionId: reviewResult.sessionId,
              lastExitCode: reviewResult.exitCode,
              lastFailureCategory: reviewResult.failureCategory ?? null,
              lastFailureHint: reviewResult.failureHint ?? "",
              ...(reviewResult.failureCategory === "quota" ? { finalReviewRound: reviewRound - 1 } : {})
            });

            if (runOnce) break;

            const shouldRetry = reviewResult.failureCategory === "quota"
              ? await waitForRetry({
                  fallbackMinutes: config.loop.waitMinutes ?? 30,
                  failureHint: reviewResult.failureHint,
                  retryAfterSeconds: reviewResult.retryAfterSeconds ?? null
                })
              : await waitWithCountdown(config.loop.waitMinutes ?? 30);

            if (!shouldRetry) {
              saveState({ ...loadState(), status: "stopped" });
              console.log("Autopilot interrupted during final review wait.");
              break;
            }
            continue;
          }

          notify("all_tasks_done", {
            total_tasks: finalSummary.total
          }).catch?.(() => {});
          console.log(`All tasks completed! (${finalSummary.done}/${finalSummary.total})`);
          pushToRemote();
          break;
        }

        if (!config.behavior.allowTaskGenerationWhenIdle) {
          console.log(`No ready tasks. ${finalSummary.done}/${finalSummary.total} done. Remaining tasks may be blocked or all complete. — check task dependencies in dev/task.json or reassign blocked tasks`);
          break;
        }

        if (task === null) {
          console.log(`No runnable tasks remain after idle planning round. (${finalSummary.done}/${finalSummary.total})`);
          break;
        }
      }

      if (runOnce) {
        break;
      }

      console.log(`Round done, next round... (${readyCheck.length} tasks ready, ${finalSummary.done}/${finalSummary.total} done)`);
      continue;
    }

    const retryCount = loadState().retryCount ?? 0;
    if (result.failureCategory !== "quota" && retryCount >= (config.loop.maxRetries ?? 12)) {
      saveState({ ...loadState(), status: "error" });
      notify("error", {
        error_message: `Max retries reached (${retryCount})`,
        last_hint: result.failureHint ?? ""
      }).catch?.(() => {});
      console.error(`Autopilot stopped after reaching max retries (${retryCount}). — check .autopilot/logs/autopilot.log for failure details and resolve the underlying issue before restarting`);
      process.exit(1);
    }

    if (result.failureCategory === "quota") {
      const retryInfo = result.retryAfterSeconds != null
        ? ` (retry after ${formatDuration(result.retryAfterSeconds)})`
        : "";
      console.log(`AI quota or rate limit detected${retryInfo}. Waiting for capacity to recover ${retryCount}/${config.loop.maxRetries}.`);
      if (result.failureHint) {
        console.log(`  Hint: ${result.failureHint.slice(0, 200)}`);
      }
      notify("quota_wait", {
        retry_after_seconds: result.retryAfterSeconds ?? null,
        quota_type: result.failureCategory,
        retry_count: retryCount
      }).catch?.(() => {});
    } else {
      console.log(`AI exited with code ${result.exitCode}. Waiting before retry ${retryCount}/${config.loop.maxRetries}.`);
      if (result.failureHint) {
        console.log(`  Hint: ${result.failureHint.slice(0, 200)}`);
      }
    }
    const shouldContinue = result.failureCategory === "quota"
      ? await waitForRetry({
          fallbackMinutes: config.loop.waitMinutes ?? 30,
          failureHint: result.failureHint,
          retryAfterSeconds: result.retryAfterSeconds ?? null
        })
      : await waitWithCountdown(config.loop.waitMinutes ?? 30);
    if (!shouldContinue) {
      saveState({ ...loadState(), status: "stopped" });
      console.log("Autopilot interrupted during wait.");
      break;
    }
  }
}

// Only run main() when executed directly (not when imported for testing)
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main().catch((error) => {
    saveState({
      ...loadState(),
      status: "error",
      lastError: String(error)
    });
    notify("error", {
      error_message: String(error),
      stack: error?.stack ?? ""
    }).catch?.(() => {});
    console.error(error);
    process.exit(1);
  });
}

// Export for testing
export { getTasks, getReadyTasks, getNextTask, getTaskProgressSummary, detectFailureCategory, tryParseStructuredError, detectFailureCategoryFromText, resolveModel, buildPrompt, buildReviewGateInstructions, buildFinalReviewPrompt, computeMaxReviewRounds, loadSkillInstructions, getSkillExecutionOrder, topoSortSkills, recordTaskMetrics, checkGeminiPrerequisites, buildGeminiDelegationBlock, parseCompletionStatus, ensureCleanWorkingTree, pushToRemote };
