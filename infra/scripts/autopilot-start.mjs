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
  return readJson("dev/task.json", { tasks: [] }).tasks ?? [];
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
  if (!task) {
    return config.models.planning;
  }

  if (["planning", "research", "review", "docs"].includes(task.type)) {
    return config.models.planning;
  }

  return config.models.execution;
}

function buildPrompt(task, config) {
  const progress = getProgressTail();
  const summary = getTaskProgressSummary();
  const sharedHeader = [
    "You are the continuous delivery agent for this repository.",
    "Operate autonomously and do not ask the user questions unless blocked by missing external information.",
    "Always read AGENTS.md, .planning/STATE.md, .planning/ROADMAP.md, dev/task.json, and dev/progress.txt before making changes.",
    "",
    `Current task completion: ${summary.done}/${summary.total}`,
    "",
    "Recent progress:",
    progress || "(no progress logged yet)",
    ""
  ].join("\n");

  if (task) {
    const criteria = (task.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
    return [
      sharedHeader,
      "Next runnable task:",
      `- ID: ${task.id}`,
      `- Name: ${task.name}`,
      `- Type: ${task.type}`,
      `- Priority: ${task.priority}`,
      `- Description: ${task.description}`,
      "",
      "Acceptance criteria:",
      criteria || "- (none provided)",
      "",
      "Execution rules:",
      "1. Complete the task in the smallest useful slice.",
      "2. Update dev/task.json, dev/progress.txt, and .planning/STATE.md before finishing.",
      "3. Run a verification step before declaring the task complete.",
      "4. If blocked, set the task status to blocked and record the reason in progress/state.",
      "5. If the task is done, mark it done and move the project forward."
    ].join("\n");
  }

  const idleInstruction = config.behavior.allowTaskGenerationWhenIdle
    ? "No runnable todo task exists. Inspect REQUIREMENTS, ROADMAP, and STATE. If the current milestone still has unfinished work, create 1-3 small next tasks in dev/task.json, update STATE/progress, and continue the project."
    : "No runnable todo task exists. Audit the repository, summarize whether the current milestone is complete, and stop if there is no clear next task.";

  return [
    sharedHeader,
    idleInstruction,
    "",
    "Guardrails:",
    "1. Do not invent large new scope.",
    "2. Keep tasks small and verifiable.",
    "3. Prefer planning the next slice over making risky assumptions."
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

async function waitForRetry({ fallbackMinutes, failureHint }) {
  const parsedSeconds = parseQuotaResetWaitSeconds(failureHint);
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

  return null;
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
  let failureCategory = null;
  let failureHint = "";
  let missingSessionDetected = false;
  const heartbeat = setInterval(() => {
    const idleSeconds = Math.floor((Date.now() - lastOutputAt) / 1000);
    console.log(`[working] AI is still processing... idle ${idleSeconds}s`);
  }, Math.max(5, config.loop.heartbeatSeconds ?? 10) * 1000);

  const outputReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  outputReader.on("line", (line) => {
    lastOutputAt = Date.now();
    logStream.write(`${line}\n`);
    failureCategory = failureCategory || detectFailureCategory(line);
    if (!failureHint && failureCategory) {
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
    failureCategory = failureCategory || detectFailureCategory(text);
    if (!failureHint && failureCategory) {
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
    failureCategory = failureCategory || detectFailureCategory(text);
    if (!failureHint && failureCategory) {
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

  clearInterval(heartbeat);
  logStream.end();
  outputStream.end();

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
    failureCategory,
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

  while (true) {
    if (pathExists(".autopilot/.stop")) {
      saveState({ ...loadState(), status: "stopped" });
      console.log("Stop signal detected. Autopilot is stopping.");
      break;
    }

    const currentState = loadState();
    const task = getNextTask();
    const model = resolveModel(task, config);
    const prompt = buildPrompt(task, config);

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
      const nextTask = getNextTask();
      if (!nextTask && !config.behavior.allowTaskGenerationWhenIdle) {
        console.log("No runnable tasks remain. Autopilot is stopping.");
        break;
      }
      if (!nextTask && task === null) {
        console.log("No runnable tasks remain after idle planning round. Autopilot is stopping.");
        break;
      }
      if (runOnce) {
        break;
      }
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
          failureHint: result.failureHint
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
