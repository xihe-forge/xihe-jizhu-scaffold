import { appendFileSync, createWriteStream, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";
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
  sleep,
  writeJson
} from "./lib/utils.mjs";
import {
  DEFAULT_AUTOPILOT_CONFIG,
  fillTemplateArgs,
  loadAutopilotConfig,
  probeRunner,
  renderRunnerSummary,
  resolveRunnerProfile
} from "./lib/autopilot-runner.mjs";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const runOnce = args.includes("--once");

function loadConfig() {
  ensureDir(".autopilot");
  if (!pathExists(".autopilot/config.json")) {
    writeJson(".autopilot/config.json", DEFAULT_AUTOPILOT_CONFIG);
  }
  return loadAutopilotConfig({ persist: true });
}

function loadState() {
  return readJson(".autopilot/state.json", {
    status: "idle",
    sessionId: "",
    retryCount: 0,
    round: 0,
    lastExitCode: null,
    lastTaskId: null,
    updatedAt: new Date().toISOString()
  });
}

function saveState(nextState) {
  writeJson(".autopilot/state.json", {
    ...nextState,
    updatedAt: new Date().toISOString()
  });
}

function clearStopSignal() {
  if (pathExists(".autopilot/.stop")) {
    rmSync(".autopilot/.stop", { force: true });
  }
}

function getTasks() {
  const raw = readJson("dev/task.json", { tasks: [] }).tasks ?? [];
  return raw.filter((task) => task && task.id);
}

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
        return !dependencyTask || dependencyTask.status === "done";
      });

      if (depsSatisfied) {
        return task;
      }
    }
  }

  return null;
}

function getReadyTasks() {
  const tasks = getTasks();
  const ready = [];

  const cycles = detectCycles(tasks);
  const cycleTaskIds = new Set();
  for (const cycle of cycles) {
    const cycleWithoutDuplicate = cycle.slice(0, -1);
    const label = cycle.join(" → ");
    console.warn(`WARNING: Circular dependency detected: ${label}`);
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
        return !dependencyTask || dependencyTask.status === "done";
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

function getTaskProgressSummary() {
  const tasks = getTasks();
  return {
    done: tasks.filter((task) => task.status === "done").length,
    total: tasks.length
  };
}

function resolveModel(task, config) {
  return config.models.planning;
}

function buildPrompt(readyTasks, config) {
  const progress = getProgressTail();
  const summary = getTaskProgressSummary();
  const task = readyTasks.length > 0 ? readyTasks[0] : null;
  const sharedHeader = [
    "You are the continuous delivery agent for this repository.",
    "Operate autonomously and do not ask the user questions unless blocked by missing external information.",
    "",
    "## Mandatory Reading (every round)",
    "Read these files before making any changes:",
    "- AGENTS.md (role division, parallel strategy, quality gates)",
    "- .planning/STATE.md (current status)",
    "- .planning/ROADMAP.md (phase sequence)",
    "- dev/task.json (task queue)",
    "",
    `Current task completion: ${summary.done}/${summary.total}`,
    "",
    "Recent progress:",
    progress || "(no progress logged yet)",
    ""
  ].join("\n");

  if (readyTasks.length > 1) {
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
        `- Description: ${t.description}`,
        "Acceptance criteria:",
        criteria || "- (none provided)",
        ""
      ].join("\n");
    }

    return [
      sharedHeader,
      `## Ready Tasks (${readyTasks.length} tasks with all dependencies satisfied)`,
      "",
      "The following tasks are ALL ready to execute. Execute as many in parallel as possible.",
      "",
      taskList,
      "## Execution Strategy",
      "You are the Opus orchestrator. Follow this workflow:",
      "",
      "1. Read AGENTS.md and relevant docs for these tasks.",
      "2. Launch one Sonnet sub-Agent per task, all in parallel:",
      "   - EVERY Agent MUST use `isolation: 'worktree'` and `model: 'sonnet'`.",
      "   - Each Agent gets its own git branch and working directory.",
      "3. After ALL Agents complete:",
      "   - Review each Agent's changes.",
      "   - Merge branches sequentially into the current branch.",
      "   - Resolve conflicts if any.",
      "4. Run verification on the merged result.",
      "5. Update dev/task.json — set ALL completed tasks to done.",
      "6. Update dev/progress.txt with what was accomplished for each task.",
      "7. Update .planning/STATE.md.",
      "8. Git commit all final changes together.",
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
    return [
      sharedHeader,
      "## Current Task",
      `- ID: ${task.id}`,
      `- Name: ${task.name}`,
      `- Type: ${task.type}`,
      `- Priority: ${task.priority}`,
      `- Description: ${task.description}`,
      "",
      "Acceptance criteria:",
      criteria || "- (none provided)",
      "",
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
      "5. Run verification: build, lint, or test as appropriate.",
      "6. Update dev/task.json (set status to done).",
      "7. Update dev/progress.txt with what was accomplished.",
      "8. Update .planning/STATE.md if any decisions were made.",
      "9. Git commit all final changes together.",
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

function handleRunnerLine({ runner, line, outputStream, currentSessionId }) {
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
      sessionId: state.sessionId || ""
    };
  }

  const logStream = createWriteStream(".autopilot/logs/autopilot.log", { flags: "a" });
  const outputStream = createWriteStream(".autopilot/logs/assistant-output.log", { flags: "a" });

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
    console.error(`[timeout] Task exceeded ${taskTimeoutSeconds}s limit. Sending SIGTERM to child process.`);
    child.kill("SIGTERM");
    sigkillTimer = setTimeout(() => {
      if (!child.killed) {
        console.error("[timeout] Child did not exit after SIGTERM. Sending SIGKILL.");
        child.kill("SIGKILL");
      }
    }, 5000);
  }, taskTimeoutSeconds * 1000);

  const outputReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  outputReader.on("line", (line) => {
    lastOutputAt = Date.now();
    logStream.write(`${line}\n`);
    failureDetection = failureDetection || detectFailureCategory(line);
    if (!failureHint && failureDetection) {
      failureHint = line.trim();
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
      currentSessionId: resolvedSessionId
    });
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    logStream.write(text);
    failureDetection = failureDetection || detectFailureCategory(text);
    if (!failureHint && failureDetection) {
      failureHint = text.trim();
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
    failureDetection = failureDetection || detectFailureCategory(text);
    if (!failureHint && failureDetection) {
      failureHint = text.trim();
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
  logStream.end();
  outputStream.end();

  if (timedOut) {
    return {
      exitCode,
      sessionId: resolvedSessionId,
      failureCategory: "timeout",
      failureHint: `Task execution timed out after ${taskTimeoutSeconds}s`
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
    failureHint
  };
}

async function main() {
  const config = loadConfig();
  const runner = resolveRunnerProfile(config);

  if (runner.mode === "claude" && process.env.CLAUDECODE) {
    console.error("Autopilot must be started outside an existing Claude Code session.");
    process.exit(1);
  }

  const probe = probeRunner(config);
  if (!probe.passed) {
    console.error(`Configured runner is not ready: ${renderRunnerSummary(config)}`);
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

  const state = loadState();
  saveState({ ...state, status: "starting" });

  process.on("SIGINT", () => {
    saveState({ ...loadState(), status: "stopped" });
    process.exit(130);
  });

  const taskRetryMap = new Map();

  while (true) {
    if (pathExists(".autopilot/.stop")) {
      saveState({ ...loadState(), status: "stopped" });
      console.log("Stop signal detected. Autopilot is stopping.");
      break;
    }

    const currentState = loadState();
    const readyTasks = getReadyTasks();
    const task = readyTasks.length > 0 ? readyTasks[0] : null;
    const model = resolveModel(task, config);
    const prompt = buildPrompt(readyTasks, config);

    saveState({
      ...currentState,
      status: "running",
      round: (currentState.round ?? 0) + 1,
      lastTaskId: task?.id ?? null
    });

    console.log("");
    console.log(`Autopilot round ${loadState().round}`);
    console.log(`Mode: ${task ? `task ${task.id}` : "idle planning"}`);
    console.log(`Runner: ${renderRunnerSummary(config)}`);
    console.log(`Model: ${model}`);

    const result = await invokeRunner({
      prompt,
      model,
      config,
      state: loadState(),
      taskId: task?.id ?? null
    });

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
          `Task ${taskId ?? "(idle)"} timed out and exceeded max task retries (${maxTaskRetries}). Marking as failed and moving on.`
        );
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
        if (finalSummary.done >= finalSummary.total && finalSummary.total > 0) {
          console.log(`All tasks completed! (${finalSummary.done}/${finalSummary.total})`);
          break;
        }

        if (!config.behavior.allowTaskGenerationWhenIdle) {
          console.log(`No ready tasks. ${finalSummary.done}/${finalSummary.total} done. Remaining tasks may be blocked or all complete.`);
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
      console.error(`Autopilot stopped after reaching max retries (${retryCount}).`);
      process.exit(1);
    }

    if (result.failureCategory === "quota") {
      console.log(`AI quota or rate limit detected. Waiting for capacity to recover ${retryCount}/${config.loop.maxRetries}.`);
    } else {
      console.log(`AI exited with code ${result.exitCode}. Waiting before retry ${retryCount}/${config.loop.maxRetries}.`);
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

main().catch((error) => {
  saveState({
    ...loadState(),
    status: "error",
    lastError: String(error)
  });
  console.error(error);
  process.exit(1);
});
