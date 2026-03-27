/**
 * autopilot-phases.mjs
 *
 * Named functions extracted from main() in autopilot-start.mjs.
 * Pure refactor — no behaviour changes.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { readJson, readText, rootDir } from "./utils.mjs";

// ---------------------------------------------------------------------------
// 1. filterTasksByAvailableRunners
// ---------------------------------------------------------------------------

/**
 * Pre-flight filter: removes tasks whose runner (codex / gemini) is not
 * currently available.
 *
 * @param {Array} readyTasks
 * @param {{ checkCodexPrerequisites: Function, checkGeminiPrerequisites: Function }} fns
 * @returns {{ filteredTasks: Array, hasCodexTasks: boolean, hasGeminiTasks: boolean,
 *             codexCheck: object, geminiCheck: object }}
 */
export function filterTasksByAvailableRunners(readyTasks, { checkCodexPrerequisites, checkGeminiPrerequisites }) {
  let filteredTasks = readyTasks.slice();

  const hasCodexTasks = readyTasks.some(t => t.assignee === "codex");
  const codexCheck = hasCodexTasks ? checkCodexPrerequisites() : { available: true, issues: [] };
  if (!codexCheck.available) {
    const codexTasks = filteredTasks.filter((t) => t.assignee === "codex");
    if (codexTasks.length > 0) {
      console.warn(`[autopilot] Codex prerequisites missing — skipping ${codexTasks.length} codex-assigned task(s) — install codex CLI or reassign tasks to sonnet in dev/task.json`);
      for (const issue of codexCheck.issues) console.warn(`  - ${issue}`);
      for (const ct of codexTasks) console.warn(`  - Skipped: ${ct.id} (${ct.name})`);
      filteredTasks = filteredTasks.filter((t) => t.assignee !== "codex");
    }
  }

  const hasGeminiTasks = readyTasks.some(t => t.assignee === "gemini");
  const geminiCheck = hasGeminiTasks ? checkGeminiPrerequisites() : { available: true, issues: [] };
  if (!geminiCheck.available) {
    const geminiTasks = filteredTasks.filter((t) => t.assignee === "gemini");
    if (geminiTasks.length > 0) {
      console.warn(`[autopilot] Gemini prerequisites missing — skipping ${geminiTasks.length} gemini-assigned task(s) — install gemini CLI or reassign tasks to sonnet in dev/task.json`);
      for (const issue of geminiCheck.issues) console.warn(`  - ${issue}`);
      for (const gt of geminiTasks) console.warn(`  - Skipped: ${gt.id} (${gt.name})`);
      filteredTasks = filteredTasks.filter((t) => t.assignee !== "gemini");
    }
  }

  return { filteredTasks, hasCodexTasks, hasGeminiTasks, codexCheck, geminiCheck };
}

// ---------------------------------------------------------------------------
// 2. handleUnavailableRunners
// ---------------------------------------------------------------------------

/**
 * Handles the case where all ready tasks were filtered out due to missing CLIs.
 *
 * @param {{ getReadyTasks: Function, runOnce: boolean, waitWithCountdown: Function }} fns
 * @param {{ unavailableCliPollCount: number, MAX_UNAVAILABLE_CLI_POLLS: number,
 *           loadState: Function, saveState: Function }} ctx
 * @returns {{ action: "continue" | "break" | "proceed", newCount: number }}
 */
export async function handleUnavailableRunners(
  { getReadyTasks, runOnce, waitWithCountdown },
  { unavailableCliPollCount, MAX_UNAVAILABLE_CLI_POLLS, loadState, saveState }
) {
  const originalReady = getReadyTasks();
  if (originalReady.length > 0) {
    const newCount = unavailableCliPollCount + 1;
    if (newCount >= MAX_UNAVAILABLE_CLI_POLLS) {
      console.error(`[autopilot] All remaining tasks require unavailable CLIs. Reassign tasks or install the required CLI. Autopilot stopping.`);
      saveState({ ...loadState(), status: "blocked" });
      return { action: "break", newCount };
    }
    console.warn(`[autopilot] All ready tasks require unavailable CLI tools (attempt ${newCount}/${MAX_UNAVAILABLE_CLI_POLLS}). Waiting for next round. — install the required CLI tool or reassign the task to an available runner`);
    if (runOnce) return { action: "break", newCount };
    await waitWithCountdown(1);
    return { action: "continue", newCount };
  }
  return { action: "proceed", newCount: unavailableCliPollCount };
}

// ---------------------------------------------------------------------------
// 3. handleSuccessResult
// ---------------------------------------------------------------------------

/**
 * Handles the exitCode === 0 path for a regular task invocation.
 *
 * @param {{ parseCompletionStatus: Function, scanForDangerousOperations: Function,
 *           appendProgressEntry: Function, ensureCleanWorkingTree: Function,
 *           notify: Function, formatDuration: Function, readJson: Function,
 *           writeJson: Function, loadState: Function, saveState: Function,
 *           runOnce: boolean }} fns
 * @param {{ task: object, result: object, taskDurationMs: number, round: number }} ctx
 * @returns {{ action: "continue" | "break" | "stop" }}
 */
export function handleSuccessResult(
  { parseCompletionStatus, scanForDangerousOperations, appendProgressEntry, ensureCleanWorkingTree,
    notify, formatDuration, readJson, writeJson, loadState, saveState, runOnce },
  { task, result, taskDurationMs, round }
) {
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

  const dangerousOps = scanForDangerousOperations(agentOutput);
  if (dangerousOps.length > 0) {
    console.warn(`⚠ Dangerous operations detected in agent output: ${dangerousOps.join(", ")}`);
    appendProgressEntry(`[WARNING] Round ${round}: dangerous operations detected — ${dangerousOps.join(", ")}`);
  }

  if (completionStatus.status === "BLOCKED") {
    console.error(`Task blocked: ${completionStatus.details} — check task dependencies in dev/task.json or reassign blocked tasks`);
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
    return { action: "continue", status: "BLOCKED" };
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
    return { action: "break", status: "NEEDS_CONTEXT" };
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

  return { action: "proceed", status: completionStatus.status };
}

// ---------------------------------------------------------------------------
// 4. handleTimeoutResult
// ---------------------------------------------------------------------------

/**
 * Handles the failureCategory === "timeout" path.
 *
 * @param {{ notify: Function, appendProgressEntry: Function, readJson: Function,
 *           writeJson: Function, loadState: Function, saveState: Function,
 *           runOnce: boolean }} fns
 * @param {{ task: object|null, result: object, config: object,
 *           taskRetryMap: Map }} ctx
 * @returns {{ action: "continue" | "break" }}
 */
export function handleTimeoutResult(
  { notify, appendProgressEntry, readJson, writeJson, loadState, saveState, runOnce },
  { task, result, config, taskRetryMap }
) {
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
    appendProgressEntry(`Task ${taskId ?? "idle"} timeout_skip after ${nextTaskRetries} retries: ${result.failureHint ?? ""}`);
    if (runOnce) {
      return { action: "break" };
    }
    return { action: "continue" };
  }

  if (runOnce) {
    return { action: "break" };
  }
  return { action: "continue" };
}

// ---------------------------------------------------------------------------
// 5. handleFailureWait
// ---------------------------------------------------------------------------

/**
 * Handles the wait logic after a failed invocation (quota or other).
 *
 * @param {{ waitForRetry: Function, waitWithCountdown: Function,
 *           loadState: Function, saveState: Function,
 *           formatDuration: Function, notify: Function }} fns
 * @param {{ result: object, config: object }} ctx
 * @returns {{ action: "continue" | "break" }}
 */
export async function handleFailureWait(
  { waitForRetry, waitWithCountdown, loadState, saveState, formatDuration, notify },
  { result, config }
) {
  if (result.failureCategory === "quota") {
    const retryInfo = result.retryAfterSeconds != null
      ? ` (retry after ${formatDuration(result.retryAfterSeconds)})`
      : "";
    const retryCount = loadState().retryCount ?? 0;
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
    const retryCount = loadState().retryCount ?? 0;
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
    return { action: "break" };
  }
  return { action: "continue" };
}

// ---------------------------------------------------------------------------
// 6. handleResumeDecision
// ---------------------------------------------------------------------------

/**
 * Handles the "awaiting_user_decision" state at startup.
 *
 * @param {{ getTasks: Function, computeMaxReviewRounds: Function,
 *           countSourceFiles: Function, readJson: Function, writeJson: Function,
 *           saveState: Function, pushToRemote: Function,
 *           acceptAsIs: boolean, continueReview: boolean }} fns
 * @param {{ state: object }} ctx
 * @returns {{ action: "exit" | "resume" }}
 */
export function handleResumeDecision(
  { getTasks, computeMaxReviewRounds, countSourceFiles, readJson, writeJson,
    saveState, pushToRemote, acceptAsIs, continueReview },
  { state }
) {
  const pauseReason = state.needsContextDetails ? "needs_context" : "review_max_rounds";

  if (pauseReason === "needs_context" && !acceptAsIs) {
    if (continueReview) {
      // --continue-review is not applicable to needs_context, treat as resume
      console.log("Resuming after context was provided...");
      saveState({ ...state, status: "running", needsContextDetails: undefined });
    } else {
      console.log("");
      console.log("Autopilot is paused — a task needs additional context.");
      console.log(`Task: ${state.lastTaskId}`);
      console.log(`Details: ${state.needsContextDetails}`);
      console.log("");
      console.log("Options:");
      console.log("  pnpm work --continue-review  → resume the task (after providing context)");
      console.log("  pnpm work --accept-as-is     → skip this task and continue");
      console.log("");
      return { action: "exit", exitCode: 0 };
    }
  }

  if (acceptAsIs) {
    if (pauseReason === "needs_context") {
      console.log("Skipping blocked task and continuing.");
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
      return { action: "exit", exitCode: 0 };
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
    return { action: "exit", exitCode: 0 };
  }

  return { action: "resume" };
}

// ---------------------------------------------------------------------------
// 7. runFinalReviewPhase
// ---------------------------------------------------------------------------

/**
 * Runs one iteration of the final review sub-loop (when all tasks are done).
 *
 * @param {{ invokeRunner: Function, recordTaskMetrics: Function,
 *           getTasks: Function, buildFinalReviewPrompt: Function,
 *           computeMaxReviewRounds: Function, countSourceFiles: Function,
 *           checkCodexPrerequisites: Function, checkGeminiPrerequisites: Function,
 *           renderRunnerSummary: Function, notify: Function,
 *           waitForRetry: Function, waitWithCountdown: Function,
 *           readJson: Function, readText: Function,
 *           loadState: Function, saveState: Function,
 *           pushToRemote: Function, runOnce: boolean }} fns
 * @param {{ config: object, finalSummary: object,
 *           metricsSessionId: string, metricsSessionStartedAt: string }} ctx
 * @returns {{ action: "break" | "continue" | "all_done" }}
 */
export async function runFinalReviewPhase(
  { invokeRunner, recordTaskMetrics, getTasks, buildFinalReviewPrompt,
    computeMaxReviewRounds, countSourceFiles, checkCodexPrerequisites,
    checkGeminiPrerequisites, renderRunnerSummary, notify,
    waitForRetry, waitWithCountdown, readJson, readText,
    loadState, saveState, pushToRemote, runOnce },
  { config, finalSummary, metricsSessionId, metricsSessionStartedAt }
) {
  const planConfig = readJson(".planning/config.json", {});
  const finalReviewEnabled = planConfig?.final_review?.enabled ?? false;
  const currentStatus = loadState().status;

  if (!finalReviewEnabled || currentStatus === "final_review_done" || currentStatus === "awaiting_user_decision") {
    // No final review — signal to the caller to wrap up
    return { action: "all_done" };
  }

  const reviewStrategy = planConfig?.review_strategy;
  const stateMaxRounds = loadState().sessionMaxRounds;
  const maxRounds = stateMaxRounds ?? computeMaxReviewRounds({
    taskCount: finalSummary.total,
    sourceFileCount: countSourceFiles(),
    configMaxRounds: planConfig.final_review.max_rounds,
    reviewStrategy
  });
  let reviewRound = loadState().finalReviewRound ?? 0;
  // Tracks how many consecutive review rounds produced zero new issues
  let consecutiveZeroRounds = loadState().consecutiveZeroRounds ?? 0;

  if (reviewRound >= maxRounds) {
    // Max rounds reached — check if unresolved issues exist
    const unresolvedPath = "dev/review/FINAL-REVIEW-UNRESOLVED.md";
    const unresolvedContent = readText(unresolvedPath, "");
    const hasUnresolved = unresolvedContent.trim().length > 0;

    if (hasUnresolved) {
      let branchName = "unknown";
      try { branchName = execSync("git rev-parse --abbrev-ref HEAD", { timeout: 5000, stdio: "pipe" }).toString().trim(); } catch { /* ignore */ }
      const projectName = planConfig?.project_name ?? path.basename(rootDir);
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
      return { action: "break" };
    }

    console.log(`Final review completed after ${reviewRound} rounds — no unresolved issues. (${finalSummary.done}/${finalSummary.total})`);
    saveState({ ...loadState(), status: "final_review_done" });
    pushToRemote();
    return { action: "break" };
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
    consecutiveZeroRounds
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
          return { action: "break" };
        }
      }

      // New issues found — reset consecutive-zero counter and advance round
      saveState({ ...loadState(), round: (loadState().round ?? 0) + 1, consecutiveZeroRounds: 0 });
      console.log(`Review round ${reviewRound} created ${newTodoTasks.length} fix task(s). Consecutive zero-issue streak reset. Executing fixes before next review.`);
      if (runOnce) return { action: "break" };
      return { action: "continue" };
    }

    // No new tasks — increment consecutive-zero counter
    consecutiveZeroRounds += 1;
    const requiredZeroRounds = 3;

    // No new tasks = converged or max rounds
    if (reviewRound >= maxRounds) {
      console.log(`Final review completed after ${reviewRound} rounds (max reached).`);
      saveState({ ...loadState(), status: "final_review_done", consecutiveZeroRounds });
      pushToRemote();
      return { action: "break" };
    }

    if (consecutiveZeroRounds >= requiredZeroRounds) {
      console.log(`Review round ${reviewRound} found no new issues (${consecutiveZeroRounds} consecutive clean rounds ≥ ${requiredZeroRounds} required). Review CONVERGED.`);
      notify("final_review_done", {
        rounds_taken: reviewRound,
        consecutive_clean_rounds: consecutiveZeroRounds,
        issues_found: 0
      }).catch?.(() => {});
      saveState({ ...loadState(), status: "final_review_done", consecutiveZeroRounds });
      pushToRemote();
      return { action: "break" };
    }

    console.log(`Review round ${reviewRound} found no new issues (${consecutiveZeroRounds}/${requiredZeroRounds} consecutive clean rounds required). Continuing review.`);
    saveState({ ...loadState(), consecutiveZeroRounds });
    if (runOnce) return { action: "break" };
    return { action: "continue" };
  }

  // Review round failed (quota, error, etc.) — handle via normal retry logic
  if (reviewResult.failureCategory === "quota") {
    console.log("Quota hit during final review. Will retry after wait.");
  }

  saveState({
    ...loadState(),
    status: reviewResult.failureCategory === "quota" ? "waiting_quota" : "waiting_retry",
    sessionId: reviewResult.sessionId,
    lastExitCode: reviewResult.exitCode,
    lastFailureCategory: reviewResult.failureCategory ?? null,
    lastFailureHint: reviewResult.failureHint ?? "",
    finalReviewRound: reviewRound - 1,
    consecutiveZeroRounds
  });

  if (runOnce) return { action: "break" };

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
    return { action: "break" };
  }
  return { action: "continue" };
}
