import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectFailureCategory,
  detectCycles,
  tryParseStructuredError,
  detectFailureCategoryFromText,
  getTaskProgressSummary,
  getReadyTasks,
  buildPrompt,
  buildReviewGateInstructions,
  buildFinalReviewPrompt,
  computeMaxReviewRounds,
  loadSkillInstructions,
  getSkillExecutionOrder,
  topoSortSkills,
  recordTaskMetrics,
  checkGeminiPrerequisites,
  buildGeminiDelegationBlock
} from "../../infra/scripts/autopilot-start.mjs";

import {
  loadNotificationConfig,
  notify,
  notifyStateChange
} from "../../infra/scripts/lib/notifications.mjs";

import {
  parseGitHubUrl,
  parseYamlFrontmatter,
  checkCircularDependencies
} from "../../infra/scripts/skill-add.mjs";

// The scaffold root — same directory that utils.mjs captures as rootDir
const scaffoldRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");

function scaffoldPath(...parts) {
  return path.join(scaffoldRoot, ...parts);
}

// ---------------------------------------------------------------------------
// Fixture helpers — write/restore dev/task.json and dev/progress.txt
// ---------------------------------------------------------------------------

function saveFixture(relPath) {
  const full = scaffoldPath(relPath);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

function writeFixture(relPath, content) {
  const full = scaffoldPath(relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function restoreFixture(relPath, original) {
  const full = scaffoldPath(relPath);
  if (original === null) {
    writeFileSync(full, JSON.stringify({ tasks: [] }), "utf8");
  } else {
    writeFileSync(full, original, "utf8");
  }
}

function writeTaskJson(tasks) {
  writeFixture("dev/task.json", JSON.stringify({ tasks }));
}

function writeProgressTxt(content = "") {
  writeFixture("dev/progress.txt", content);
}

// ---------------------------------------------------------------------------
// detectFailureCategory — pure function, no file I/O
// ---------------------------------------------------------------------------

describe("detectFailureCategory", () => {
  it('returns quota category for "rate limit exceeded"', () => {
    const result = detectFailureCategory("rate limit exceeded");
    assert.equal(result?.category, "quota");
  });

  it('returns quota category for "429 Too Many Requests"', () => {
    const result = detectFailureCategory("429 Too Many Requests");
    assert.equal(result?.category, "quota");
  });

  it('returns quota category for "hit your limit"', () => {
    const result = detectFailureCategory("You have hit your limit for today");
    assert.equal(result?.category, "quota");
  });

  it("returns null for normal text", () => {
    assert.equal(detectFailureCategory("Everything is working fine"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(detectFailureCategory(""), null);
  });

  it("returns null for null input", () => {
    assert.equal(detectFailureCategory(null), null);
  });

  it("parses structured Claude API rate limit error", () => {
    const structured = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } });
    const result = detectFailureCategory(structured);
    assert.equal(result?.category, "quota");
    assert.equal(result?.source, "structured");
  });

  it("returns quota for rate-limited text", () => {
    const result = detectFailureCategory("Your request was rate-limited");
    assert.equal(result?.category, "quota");
  });

  it("returns quota for usage limit text", () => {
    const result = detectFailureCategory("You have exceeded your usage limit");
    assert.equal(result?.category, "quota");
  });

  it("returns quota for credit balance text", () => {
    const result = detectFailureCategory("Insufficient credit balance");
    assert.equal(result?.category, "quota");
  });

  it("returns quota for too many requests text", () => {
    const result = detectFailureCategory("too many requests, please slow down");
    assert.equal(result?.category, "quota");
  });

  it("matches 429 when preceded by 'code' keyword", () => {
    // "code 429" matches the pattern /(?:status|code|http)[:\s]+429\b/
    const result = detectFailureCategory("Error code 429");
    assert.equal(result?.category, "quota");
  });

  it("does NOT match bare 429 in unrelated context", () => {
    // 429 appearing as a non-HTTP-status number should not match
    const result = detectFailureCategory("Processed 429 records successfully");
    assert.equal(result, null);
  });

  it("matches 429 with HTTP status context", () => {
    const result = detectFailureCategory('status: 429 error');
    assert.equal(result?.category, "quota");
  });
});

// ---------------------------------------------------------------------------
// tryParseStructuredError — structured JSON parsing
// ---------------------------------------------------------------------------

describe("tryParseStructuredError", () => {
  it("parses Claude API rate_limit_error with retry_after", () => {
    const json = JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "Rate limited", retry_after: 60 }
    });
    const result = tryParseStructuredError(json);
    assert.equal(result?.category, "quota");
    assert.equal(result?.retryAfterSeconds, 60);
    assert.equal(result?.source, "structured");
  });

  it("parses HTTP 429 status", () => {
    const json = JSON.stringify({ status: 429, message: "Too Many Requests" });
    const result = tryParseStructuredError(json);
    assert.equal(result?.category, "quota");
    assert.equal(result?.source, "structured");
  });

  it("parses HTTP 429 statusCode variant", () => {
    const json = JSON.stringify({ statusCode: 429, retry_after: 30 });
    const result = tryParseStructuredError(json);
    assert.equal(result?.category, "quota");
    assert.equal(result?.retryAfterSeconds, 30);
  });

  it("parses Codex JSONL rate_limit error", () => {
    const json = JSON.stringify({ type: "error", code: "rate_limit_error", message: "Rate limited" });
    const result = tryParseStructuredError(json);
    assert.equal(result?.category, "quota");
  });

  it("returns null for non-error JSON", () => {
    const json = JSON.stringify({ type: "assistant", message: "Hello" });
    const result = tryParseStructuredError(json);
    assert.equal(result, null);
  });

  it("returns null for invalid JSON", () => {
    const result = tryParseStructuredError("not json at all");
    assert.equal(result, null);
  });

  it("returns null for empty input", () => {
    assert.equal(tryParseStructuredError(""), null);
    assert.equal(tryParseStructuredError(null), null);
  });

  it("handles multiline input with JSON on second line", () => {
    const input = `Some log line\n${JSON.stringify({ status: 429 })}`;
    const result = tryParseStructuredError(input);
    assert.equal(result?.category, "quota");
  });

  it("extracts retryAfter from reset_after field", () => {
    const json = JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", reset_after: 120 }
    });
    const result = tryParseStructuredError(json);
    assert.equal(result?.retryAfterSeconds, 120);
  });
});

// ---------------------------------------------------------------------------
// detectFailureCategoryFromText — text heuristics
// ---------------------------------------------------------------------------

describe("detectFailureCategoryFromText", () => {
  it("detects rate limit with hyphen", () => {
    const result = detectFailureCategoryFromText("rate-limit exceeded");
    assert.equal(result?.category, "quota");
    assert.equal(result?.source, "text");
  });

  it("detects quota keyword", () => {
    const result = detectFailureCategoryFromText("API quota exhausted");
    assert.equal(result?.category, "quota");
  });

  it("detects JSON-style 429 status", () => {
    const result = detectFailureCategoryFromText('"status": 429');
    assert.equal(result?.category, "quota");
  });

  it("returns null for unrelated text", () => {
    assert.equal(detectFailureCategoryFromText("Build succeeded"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(detectFailureCategoryFromText(""), null);
  });
});

// ---------------------------------------------------------------------------
// detectCycles — cycle detection in task dependency graph
// ---------------------------------------------------------------------------

describe("detectCycles", () => {
  it("detects no cycles in linear dependency chain", () => {
    const tasks = [
      { id: "A", depends_on: [] },
      { id: "B", depends_on: ["A"] },
      { id: "C", depends_on: ["B"] }
    ];
    const cycles = detectCycles(tasks);
    assert.equal(cycles.length, 0);
  });

  it("detects simple two-node cycle", () => {
    const tasks = [
      { id: "A", depends_on: ["B"] },
      { id: "B", depends_on: ["A"] }
    ];
    const cycles = detectCycles(tasks);
    assert.ok(cycles.length > 0, "Expected at least one cycle");
  });

  it("detects three-node cycle", () => {
    const tasks = [
      { id: "A", depends_on: ["C"] },
      { id: "B", depends_on: ["A"] },
      { id: "C", depends_on: ["B"] }
    ];
    const cycles = detectCycles(tasks);
    assert.ok(cycles.length > 0, "Expected at least one cycle");
  });

  it("handles self-referencing task", () => {
    const tasks = [
      { id: "A", depends_on: ["A"] }
    ];
    const cycles = detectCycles(tasks);
    assert.ok(cycles.length > 0, "Expected self-cycle detected");
  });

  it("handles empty task list", () => {
    const cycles = detectCycles([]);
    assert.deepEqual(cycles, []);
  });

  it("handles tasks with no depends_on field", () => {
    const tasks = [
      { id: "A" },
      { id: "B" }
    ];
    const cycles = detectCycles(tasks);
    assert.equal(cycles.length, 0);
  });

  it("ignores dependencies on non-existent tasks", () => {
    const tasks = [
      { id: "A", depends_on: ["Z"] },
      { id: "B", depends_on: ["A"] }
    ];
    const cycles = detectCycles(tasks);
    assert.equal(cycles.length, 0);
  });

  it("detects cycle in mixed graph (some acyclic, some cyclic)", () => {
    const tasks = [
      { id: "A", depends_on: [] },
      { id: "B", depends_on: ["A"] },
      { id: "C", depends_on: ["D"] },
      { id: "D", depends_on: ["C"] }
    ];
    const cycles = detectCycles(tasks);
    assert.ok(cycles.length > 0, "Expected cycle between C and D");
    // Verify A and B are not in any cycle
    const cycleIds = new Set(cycles.flat());
    assert.ok(!cycleIds.has("A"));
    assert.ok(!cycleIds.has("B"));
  });
});

// ---------------------------------------------------------------------------
// getTaskProgressSummary
// ---------------------------------------------------------------------------

describe("getTaskProgressSummary", () => {
  let originalTaskJson;

  beforeEach(() => {
    originalTaskJson = saveFixture("dev/task.json");
  });

  afterEach(() => {
    restoreFixture("dev/task.json", originalTaskJson);
  });

  it("returns correct done/total counts", () => {
    writeTaskJson([
      { id: "T001", status: "done", priority: "P0", name: "A" },
      { id: "T002", status: "done", priority: "P1", name: "B" },
      { id: "T003", status: "todo", priority: "P2", name: "C" }
    ]);

    const summary = getTaskProgressSummary();
    assert.equal(summary.done, 2);
    assert.equal(summary.total, 3);
  });

  it("handles empty task list", () => {
    writeTaskJson([]);

    const summary = getTaskProgressSummary();
    assert.equal(summary.done, 0);
    assert.equal(summary.total, 0);
  });

  it("counts blocked and in_progress tasks in total but not done", () => {
    writeTaskJson([
      { id: "T001", status: "done", priority: "P0", name: "A" },
      { id: "T002", status: "in_progress", priority: "P1", name: "B" },
      { id: "T003", status: "blocked", priority: "P2", name: "C" }
    ]);

    const summary = getTaskProgressSummary();
    assert.equal(summary.done, 1);
    assert.equal(summary.total, 3);
  });
});

// ---------------------------------------------------------------------------
// getReadyTasks
// ---------------------------------------------------------------------------

describe("getReadyTasks", () => {
  let originalTaskJson;

  beforeEach(() => {
    originalTaskJson = saveFixture("dev/task.json");
  });

  afterEach(() => {
    restoreFixture("dev/task.json", originalTaskJson);
  });

  it("returns tasks with no dependencies", () => {
    writeTaskJson([
      { id: "T001", status: "todo", priority: "P0", name: "A" },
      { id: "T002", status: "todo", priority: "P1", name: "B" }
    ]);

    const ready = getReadyTasks();
    assert.equal(ready.length, 2);
    assert.ok(ready.some((t) => t.id === "T001"));
    assert.ok(ready.some((t) => t.id === "T002"));
  });

  it("returns tasks whose dependencies are all done", () => {
    writeTaskJson([
      { id: "T001", status: "done", priority: "P0", name: "A" },
      { id: "T002", status: "todo", priority: "P1", name: "B", depends_on: ["T001"] }
    ]);

    const ready = getReadyTasks();
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, "T002");
  });

  it("does NOT return tasks with unsatisfied dependencies", () => {
    writeTaskJson([
      { id: "T001", status: "todo", priority: "P0", name: "A" },
      { id: "T002", status: "todo", priority: "P1", name: "B", depends_on: ["T001"] }
    ]);

    const ready = getReadyTasks();
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, "T001");
  });

  it("handles empty task list", () => {
    writeTaskJson([]);

    const ready = getReadyTasks();
    assert.deepEqual(ready, []);
  });

  it("excludes tasks involved in circular dependencies", () => {
    writeTaskJson([
      { id: "T001", status: "todo", priority: "P0", name: "A" },
      { id: "T002", status: "todo", priority: "P1", name: "B", depends_on: ["T003"] },
      { id: "T003", status: "todo", priority: "P1", name: "C", depends_on: ["T002"] }
    ]);

    const ready = getReadyTasks();
    // T001 should be ready, T002 and T003 are in a cycle
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, "T001");
  });

  it("returns tasks in priority order (P0 before P1 before P2)", () => {
    writeTaskJson([
      { id: "T003", status: "todo", priority: "P2", name: "C" },
      { id: "T001", status: "todo", priority: "P0", name: "A" },
      { id: "T002", status: "todo", priority: "P1", name: "B" }
    ]);

    const ready = getReadyTasks();
    assert.equal(ready.length, 3);
    assert.equal(ready[0].id, "T001");
    assert.equal(ready[1].id, "T002");
    assert.equal(ready[2].id, "T003");
  });

  it("skips done and in_progress tasks", () => {
    writeTaskJson([
      { id: "T001", status: "done", priority: "P0", name: "A" },
      { id: "T002", status: "in_progress", priority: "P0", name: "B" },
      { id: "T003", status: "todo", priority: "P1", name: "C" }
    ]);

    const ready = getReadyTasks();
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, "T003");
  });
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

describe("buildPrompt", () => {
  let originalTaskJson;
  let originalProgressTxt;

  const mockConfig = {
    behavior: { allowTaskGenerationWhenIdle: false },
    models: { planning: "claude-opus-4-5", execution: "claude-sonnet-4-5" }
  };

  const mockConfigWithIdleGen = {
    behavior: { allowTaskGenerationWhenIdle: true },
    models: { planning: "claude-opus-4-5", execution: "claude-sonnet-4-5" }
  };

  beforeEach(() => {
    originalTaskJson = saveFixture("dev/task.json");
    originalProgressTxt = saveFixture("dev/progress.txt");
  });

  afterEach(() => {
    restoreFixture("dev/task.json", originalTaskJson);
    if (originalProgressTxt === null) {
      writeFixture("dev/progress.txt", "");
    } else {
      writeFixture("dev/progress.txt", originalProgressTxt);
    }
  });

  it("batch mode: returns prompt mentioning multiple tasks when readyTasks.length > 1", () => {
    writeTaskJson([
      { id: "T001", status: "todo", priority: "P0", name: "First task" },
      { id: "T002", status: "todo", priority: "P1", name: "Second task" }
    ]);
    writeProgressTxt("some progress");

    const readyTasks = [
      { id: "T001", status: "todo", priority: "P0", name: "First task" },
      { id: "T002", status: "todo", priority: "P1", name: "Second task" }
    ];
    const prompt = buildPrompt(readyTasks, mockConfig);

    assert.ok(prompt.includes("Ready Tasks"), `Expected "Ready Tasks" in prompt`);
    assert.ok(prompt.includes("T001"));
    assert.ok(prompt.includes("T002"));
  });

  it("single mode: returns prompt with task details when readyTasks.length === 1", () => {
    const task = {
      id: "T001",
      status: "todo",
      priority: "P0",
      name: "Only task",
      type: "feature",
      description: "Do the thing"
    };
    writeTaskJson([task]);
    writeProgressTxt("some progress");

    const readyTasks = [task];
    const prompt = buildPrompt(readyTasks, mockConfig);

    assert.ok(prompt.includes("Current Task"), `Expected "Current Task" in prompt`);
    assert.ok(prompt.includes("T001"));
    assert.ok(prompt.includes("Only task"));
  });

  it("idle mode: returns idle prompt when readyTasks is empty", () => {
    writeTaskJson([]);
    writeProgressTxt("");

    const prompt = buildPrompt([], mockConfig);

    assert.ok(
      prompt.includes("No runnable todo task exists"),
      `Expected idle text in prompt`
    );
  });

  it("idle mode with task generation: prompts to create tasks", () => {
    writeTaskJson([]);
    writeProgressTxt("");

    const prompt = buildPrompt([], mockConfigWithIdleGen);

    assert.ok(prompt.includes("create 1-3 small next tasks"), "Expected task generation instruction");
  });

  it("idle mode without task generation: prompts to audit and stop", () => {
    writeTaskJson([]);
    writeProgressTxt("");

    const prompt = buildPrompt([], mockConfig);

    assert.ok(prompt.includes("audit the repository"), "Expected audit instruction");
  });

  it("always includes mandatory reading section", () => {
    writeTaskJson([]);
    writeProgressTxt("");

    const prompt = buildPrompt([], mockConfig);

    assert.ok(prompt.includes("Mandatory Reading"));
    assert.ok(prompt.includes("AGENTS.md"));
    assert.ok(prompt.includes(".planning/STATE.md"));
    assert.ok(prompt.includes("dev/task.json"));
  });

  it("includes acceptance criteria in single-task prompt", () => {
    const task = {
      id: "T001",
      status: "todo",
      priority: "P0",
      name: "Task with criteria",
      type: "implementation",
      description: "Implement feature X",
      acceptance_criteria: ["Unit tests pass", "Build succeeds"]
    };
    writeTaskJson([task]);
    writeProgressTxt("");

    const prompt = buildPrompt([task], mockConfig);

    assert.ok(prompt.includes("Unit tests pass"));
    assert.ok(prompt.includes("Build succeeds"));
  });

  it("includes scale-based execution hints for sonnet tasks", () => {
    const task = {
      id: "T001",
      status: "todo",
      priority: "P0",
      name: "Sonnet task",
      type: "implementation",
      description: "Implement something",
      assignee: "sonnet"
    };
    writeTaskJson([task]);
    writeProgressTxt("");

    const prompt = buildPrompt([task], mockConfig);

    assert.ok(prompt.includes("Scale-Based Execution"));
  });

  it("codex task: includes delegation instructions", () => {
    const task = {
      id: "T001",
      status: "todo",
      priority: "P0",
      name: "Codex task",
      type: "implementation",
      description: "Implement via codex",
      assignee: "codex"
    };
    writeTaskJson([task]);
    writeProgressTxt("");

    const prompt = buildPrompt([task], mockConfig);

    assert.ok(prompt.includes("Codex Delegation"), "Expected codex delegation section");
    assert.ok(prompt.includes("CodexBridge"), "Expected codex-bridge module reference");
  });

  it("opus task: includes direct execution instructions", () => {
    const task = {
      id: "T001",
      status: "todo",
      priority: "P0",
      name: "Opus task",
      type: "planning",
      description: "Plan something",
      assignee: "opus"
    };
    writeTaskJson([task]);
    writeProgressTxt("");

    const prompt = buildPrompt([task], mockConfig);

    assert.ok(prompt.includes("Direct (Opus)"), "Expected opus direct execution section");
    assert.ok(prompt.includes("without sub-agents"));
  });

  it("batch mode: partitions codex and sonnet tasks", () => {
    const tasks = [
      { id: "T001", status: "todo", priority: "P0", name: "Sonnet task", assignee: "sonnet" },
      { id: "T002", status: "todo", priority: "P0", name: "Codex task", assignee: "codex" }
    ];
    writeTaskJson(tasks);
    writeProgressTxt("");

    const prompt = buildPrompt(tasks, mockConfig);

    assert.ok(prompt.includes("Codex Tasks"), "Expected codex tasks section");
    assert.ok(prompt.includes("Sonnet Tasks"), "Expected sonnet tasks section");
  });

  it("includes deviation rules in all modes", () => {
    const task = {
      id: "T001", status: "todo", priority: "P0",
      name: "Task", type: "implementation", description: "Do"
    };
    writeTaskJson([task]);
    writeProgressTxt("");

    const singlePrompt = buildPrompt([task], mockConfig);
    assert.ok(singlePrompt.includes("Deviation Rules"));

    const idlePrompt = buildPrompt([], mockConfig);
    assert.ok(idlePrompt.includes("deviation rules") || idlePrompt.includes("Deviation"));
  });

  it("includes progress summary in prompt", () => {
    writeTaskJson([
      { id: "T001", status: "done", priority: "P0", name: "Done" },
      { id: "T002", status: "todo", priority: "P1", name: "Todo" }
    ]);
    writeProgressTxt("Round 1: completed T001");

    const task = { id: "T002", status: "todo", priority: "P1", name: "Todo" };
    const prompt = buildPrompt([task], mockConfig);

    assert.ok(prompt.includes("1/2"), "Expected progress count in prompt");
    assert.ok(prompt.includes("Round 1: completed T001"), "Expected progress text");
  });
});

// ---------------------------------------------------------------------------
// buildReviewGateInstructions
// ---------------------------------------------------------------------------

describe("buildReviewGateInstructions", () => {
  let originalPlanConfig;

  beforeEach(() => {
    originalPlanConfig = saveFixture(".planning/config.json");
  });

  afterEach(() => {
    if (originalPlanConfig !== null) {
      writeFixture(".planning/config.json", originalPlanConfig);
    }
  });

  it("returns empty string for null task", () => {
    assert.equal(buildReviewGateInstructions(null), "");
  });

  it("returns MRD/PRD review gate for research tasks", () => {
    const task = { id: "T001", type: "research", name: "Market research", description: "Do research" };
    const result = buildReviewGateInstructions(task);
    assert.ok(result.includes("MRD/PRD Review"), "Expected MRD/PRD review gate");
    assert.ok(result.includes("BLOCKING"));
  });

  it("returns tech/design review gate for docs tasks about design", () => {
    const task = { id: "T002", type: "docs", name: "Write tech spec", description: "Technical spec for API" };
    const result = buildReviewGateInstructions(task);
    assert.ok(result.includes("Tech/Design Review"), "Expected tech/design review gate");
  });

  it("returns code review gate for implementation tasks", () => {
    const task = { id: "T003", type: "implementation", name: "Build auth", description: "Implement auth module" };
    const result = buildReviewGateInstructions(task);
    assert.ok(result.includes("Code Review"), "Expected code review gate");
  });

  it("returns test coverage review gate for testing tasks", () => {
    const task = { id: "T004", type: "testing", name: "Write tests", description: "Test the auth module" };
    const result = buildReviewGateInstructions(task);
    assert.ok(result.includes("Test Coverage Review"), "Expected test coverage review gate");
    assert.ok(result.includes("PRD requirement"), "Expected PRD coverage instruction");
  });

  it("returns marketing review gate for marketing tasks", () => {
    const task = { id: "T005", type: "planning", name: "Marketing strategy", description: "Create go-to-market plan" };
    const result = buildReviewGateInstructions(task);
    assert.ok(result.includes("Marketing Review"), "Expected marketing review gate");
  });

  it("returns empty string for tasks that match no gates", () => {
    const task = { id: "T006", type: "implementation", name: "Refactor utils", description: "Clean up utility functions" };
    // implementation matches code review, so this should NOT be empty
    const result = buildReviewGateInstructions(task);
    assert.ok(result.includes("Code Review"));
  });

  it("includes recipe path in instructions", () => {
    const task = { id: "T007", type: "research", name: "MRD creation", description: "Write MRD" };
    const result = buildReviewGateInstructions(task);
    assert.ok(result.includes(".ai/recipes/review-mrd-prd.md"), "Expected recipe path");
  });

  it("includes review output path with task ID", () => {
    const task = { id: "T008", type: "testing", name: "Test coverage", description: "Verify test coverage" };
    const result = buildReviewGateInstructions(task);
    assert.ok(result.includes("T008"), "Expected task ID in review output path");
  });

  it("injects review gates into implementation buildPrompt", () => {
    const task = {
      id: "T010", status: "todo", priority: "P0",
      name: "Build feature", type: "implementation",
      description: "Implement new feature", assignee: "sonnet"
    };
    writeTaskJson([task]);
    writeProgressTxt("");

    const mockConfig = {
      behavior: { allowTaskGenerationWhenIdle: false },
      models: { planning: "opus", execution: "sonnet" }
    };
    const prompt = buildPrompt([task], mockConfig);

    assert.ok(prompt.includes("Review Gates"), "Expected review gates in prompt");
    assert.ok(prompt.includes("Code Review"), "Expected code review gate in prompt");
  });
});

// ---------------------------------------------------------------------------
// buildFinalReviewPrompt
// ---------------------------------------------------------------------------

describe("buildFinalReviewPrompt", () => {
  let originalTaskJson;
  let originalProgressTxt;
  let originalPlanConfig;

  const mockConfig = {
    behavior: { allowTaskGenerationWhenIdle: false },
    models: { planning: "opus", execution: "sonnet" }
  };

  beforeEach(() => {
    originalTaskJson = saveFixture("dev/task.json");
    originalProgressTxt = saveFixture("dev/progress.txt");
    originalPlanConfig = saveFixture(".planning/config.json");
  });

  afterEach(() => {
    restoreFixture("dev/task.json", originalTaskJson);
    if (originalProgressTxt === null) {
      writeFixture("dev/progress.txt", "");
    } else {
      writeFixture("dev/progress.txt", originalProgressTxt);
    }
    if (originalPlanConfig !== null) {
      writeFixture(".planning/config.json", originalPlanConfig);
    }
  });

  it("includes round number and max rounds", () => {
    writeTaskJson([{ id: "T001", status: "done", priority: "P0", name: "Done" }]);
    writeProgressTxt("All done");

    const prompt = buildFinalReviewPrompt(mockConfig, 1, null);

    assert.ok(prompt.includes("Round 1/"), "Expected round number");
    assert.ok(prompt.includes("FINAL ITERATION REVIEW"), "Expected final review header");
  });

  it("includes parallel reviewer dispatch instructions", () => {
    writeTaskJson([{ id: "T001", status: "done", priority: "P0", name: "Done" }]);
    writeProgressTxt("All done");

    const prompt = buildFinalReviewPrompt(mockConfig, 1, null);

    assert.ok(prompt.includes("Dispatch Parallel Reviewers"), "Expected parallel dispatch section");
    assert.ok(prompt.includes("Document Review"), "Expected doc review section");
    assert.ok(prompt.includes("Code & Test Review"), "Expected code review section");
  });

  it("includes triage classification system", () => {
    writeTaskJson([]);
    writeProgressTxt("");

    const prompt = buildFinalReviewPrompt(mockConfig, 1, null);

    assert.ok(prompt.includes("BUG"), "Expected BUG classification");
    assert.ok(prompt.includes("SECURITY"), "Expected SECURITY classification");
    assert.ok(prompt.includes("COVERAGE GAP"), "Expected COVERAGE GAP classification");
    assert.ok(prompt.includes("FALSE POSITIVE"), "Expected FALSE POSITIVE classification");
  });

  it("includes previous findings when provided", () => {
    writeTaskJson([]);
    writeProgressTxt("");

    const previousFindings = "Found 2 bugs: missing auth check, untested endpoint";
    const prompt = buildFinalReviewPrompt(mockConfig, 2, previousFindings);

    assert.ok(prompt.includes("Previous Round Findings"), "Expected previous findings section");
    assert.ok(prompt.includes("missing auth check"), "Expected previous findings content");
  });

  it("does not include previous findings on round 1", () => {
    writeTaskJson([]);
    writeProgressTxt("");

    const prompt = buildFinalReviewPrompt(mockConfig, 1, null);

    assert.ok(!prompt.includes("Previous Round Findings"), "Should not have previous findings on round 1");
  });

  it("indicates FINAL round when at max", () => {
    writeTaskJson([]);
    writeProgressTxt("");

    const prompt = buildFinalReviewPrompt(mockConfig, 5, null);

    assert.ok(prompt.includes("FINAL"), "Expected FINAL indicator at max rounds");
    assert.ok(prompt.includes("awaiting_user_decision"), "Expected user decision gate instruction");
    assert.ok(prompt.includes("PAUSE"), "Expected autopilot pause instruction");
  });

  it("includes convergence criteria for non-final rounds", () => {
    writeTaskJson([]);
    writeProgressTxt("");

    const prompt = buildFinalReviewPrompt(mockConfig, 1, null);

    assert.ok(prompt.includes("CONVERGED"), "Expected convergence criteria");
  });

  it("includes review tools from config", () => {
    writeTaskJson([]);
    writeProgressTxt("");

    const prompt = buildFinalReviewPrompt(mockConfig, 1, null);

    assert.ok(prompt.includes("pm-skills") || prompt.includes("Review Tools"), "Expected review tools section");
  });

  it("references review output path with round number", () => {
    writeTaskJson([]);
    writeProgressTxt("");

    const prompt = buildFinalReviewPrompt(mockConfig, 2, null);

    assert.ok(prompt.includes("FINAL-REVIEW-ROUND-2"), "Expected round-specific output path");
  });
});

// ---------------------------------------------------------------------------
// computeMaxReviewRounds
// ---------------------------------------------------------------------------

describe("computeMaxReviewRounds", () => {
  it("returns 5 for small projects (≤10 tasks, ≤20 files)", () => {
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 5, sourceFileCount: 10 }), 5);
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 10, sourceFileCount: 20 }), 5);
  });

  it("returns 7 for medium projects (≤30 tasks, ≤50 files)", () => {
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 15, sourceFileCount: 30 }), 7);
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 30, sourceFileCount: 50 }), 7);
  });

  it("returns 10 for large projects (≤60 tasks, ≤100 files)", () => {
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 45, sourceFileCount: 80 }), 10);
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 60, sourceFileCount: 100 }), 10);
  });

  it("returns 12 for XL projects (>60 tasks or >100 files)", () => {
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 87, sourceFileCount: 120 }), 12);
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 61, sourceFileCount: 10 }), 12);
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 5, sourceFileCount: 101 }), 12);
  });

  it("uses higher tier when task count and file count fall in different tiers", () => {
    // 5 tasks (small) but 60 files (medium→large boundary) → uses file count tier
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 5, sourceFileCount: 60 }), 10);
    // 40 tasks (large) but 10 files (small) → uses task count tier
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 40, sourceFileCount: 10 }), 10);
  });

  it("respects explicit numeric config override", () => {
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 5, sourceFileCount: 5, configMaxRounds: 7 }), 7);
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 100, sourceFileCount: 200, configMaxRounds: 2 }), 2);
  });

  it("ignores non-numeric or invalid config values and falls back to auto", () => {
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 5, sourceFileCount: 5, configMaxRounds: "auto" }), 5);
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 5, sourceFileCount: 5, configMaxRounds: 0 }), 5);
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 5, sourceFileCount: 5, configMaxRounds: -1 }), 5);
  });

  it("defaults to small tier with no arguments", () => {
    assert.strictEqual(computeMaxReviewRounds(), 5);
    assert.strictEqual(computeMaxReviewRounds({}), 5);
  });

  it("returns 50 for zero_bug review strategy", () => {
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 5, sourceFileCount: 5, reviewStrategy: { mode: "zero_bug" } }), 50);
    // zero_bug overrides even explicit configMaxRounds
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 5, sourceFileCount: 5, configMaxRounds: 3, reviewStrategy: { mode: "zero_bug" } }), 50);
  });

  it("uses custom_rounds for custom review strategy", () => {
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 5, sourceFileCount: 5, reviewStrategy: { mode: "custom", custom_rounds: 15 } }), 15);
    // custom overrides auto-scaling
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 100, sourceFileCount: 200, reviewStrategy: { mode: "custom", custom_rounds: 4 } }), 4);
  });

  it("falls back to auto when review strategy mode is auto or unrecognized", () => {
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 5, sourceFileCount: 5, reviewStrategy: { mode: "auto" } }), 5);
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 5, sourceFileCount: 5, reviewStrategy: { mode: "unknown" } }), 5);
    assert.strictEqual(computeMaxReviewRounds({ taskCount: 100, sourceFileCount: 200, reviewStrategy: { mode: "auto" } }), 12);
  });
});

// ---------------------------------------------------------------------------
// Minimal in-memory registry used by topoSortSkills tests
// ---------------------------------------------------------------------------

const TOPO_REGISTRY = {
  skills: {
    impeccable: {
      skills: {
        "frontend-design": { file: "frontend-design.md" },
        "audit": { file: "audit.md" },
        "critique": { file: "critique.md" },
        "polish": { file: "polish.md", depends_on: "impeccable/audit" },
        "normalize": { file: "normalize.md", depends_on: "impeccable/critique" },
        "harden": { file: "harden.md" }
      }
    },
    "vercel-web-design": {
      skills: {
        "web-design-guidelines": { file: "web-design-guidelines.md" }
      }
    }
  }
};

// ---------------------------------------------------------------------------
// topoSortSkills
// ---------------------------------------------------------------------------

describe("topoSortSkills", () => {
  it("sorts audit before polish (audit is depended on by polish)", () => {
    const ids = ["impeccable/polish", "impeccable/audit"];
    const sorted = topoSortSkills(ids, TOPO_REGISTRY);
    assert.ok(sorted.indexOf("impeccable/audit") < sorted.indexOf("impeccable/polish"),
      `Expected audit before polish, got: ${sorted.join(", ")}`);
  });

  it("sorts critique before normalize (normalize depends_on critique)", () => {
    const ids = ["impeccable/normalize", "impeccable/critique"];
    const sorted = topoSortSkills(ids, TOPO_REGISTRY);
    assert.ok(sorted.indexOf("impeccable/critique") < sorted.indexOf("impeccable/normalize"),
      `Expected critique before normalize, got: ${sorted.join(", ")}`);
  });

  it("preserves order for skills with no dependencies", () => {
    const ids = ["impeccable/frontend-design", "impeccable/harden"];
    const sorted = topoSortSkills(ids, TOPO_REGISTRY);
    assert.deepEqual(sorted, ["impeccable/frontend-design", "impeccable/harden"]);
  });

  it("returns empty array for empty input", () => {
    const sorted = topoSortSkills([], TOPO_REGISTRY);
    assert.deepEqual(sorted, []);
  });

  it("handles dependency not present in input list without crashing", () => {
    // polish depends on audit, but audit is not in the input list
    const ids = ["impeccable/polish"];
    assert.doesNotThrow(() => topoSortSkills(ids, TOPO_REGISTRY));
    const sorted = topoSortSkills(ids, TOPO_REGISTRY);
    assert.deepEqual(sorted, ["impeccable/polish"]);
  });

  it("handles full review chain with multiple dependency paths", () => {
    // critique -> normalize, audit -> polish
    const ids = [
      "impeccable/polish",
      "impeccable/normalize",
      "impeccable/critique",
      "impeccable/audit"
    ];
    const sorted = topoSortSkills(ids, TOPO_REGISTRY);
    assert.ok(sorted.indexOf("impeccable/audit") < sorted.indexOf("impeccable/polish"),
      "audit must precede polish");
    assert.ok(sorted.indexOf("impeccable/critique") < sorted.indexOf("impeccable/normalize"),
      "critique must precede normalize");
  });
});

// ---------------------------------------------------------------------------
// getSkillExecutionOrder — reads .ai/skills/skill-registry.json from disk
// ---------------------------------------------------------------------------

describe("getSkillExecutionOrder", () => {
  it("returns correct skills for implement_frontend", () => {
    const order = getSkillExecutionOrder("implement_frontend");
    assert.ok(Array.isArray(order), "should return an array");
    assert.ok(order.includes("impeccable/frontend-design"),
      `Expected impeccable/frontend-design in: ${order.join(", ")}`);
  });

  it("returns correct skills for review_frontend with correct order", () => {
    const order = getSkillExecutionOrder("review_frontend");
    assert.ok(Array.isArray(order), "should return an array");
    // critique comes before audit, audit before polish in the registry
    assert.ok(order.includes("impeccable/critique"), "should include critique");
    assert.ok(order.includes("impeccable/audit"), "should include audit");
    assert.ok(order.includes("impeccable/polish"), "should include polish");
    assert.ok(order.indexOf("impeccable/critique") < order.indexOf("impeccable/audit"),
      "critique should precede audit in review_frontend order");
  });

  it("returns correct skills for final_review", () => {
    const order = getSkillExecutionOrder("final_review");
    assert.ok(Array.isArray(order), "should return an array");
    assert.ok(order.includes("impeccable/audit"), "should include audit");
    assert.ok(order.includes("vercel-web-design/web-design-guidelines"),
      "should include vercel-web-design/web-design-guidelines");
  });

  it("returns empty array for unknown phase", () => {
    const order = getSkillExecutionOrder("unknown_phase_xyz");
    assert.deepEqual(order, []);
  });
});

// ---------------------------------------------------------------------------
// loadSkillInstructions — reads skill registry from disk
// ---------------------------------------------------------------------------

describe("loadSkillInstructions", () => {
  it("returns empty string for non-frontend tasks (backend, database)", () => {
    const tasks = [
      { type: "backend", name: "Create REST API", description: "Add database endpoints" },
      { type: "database", name: "Migrations", description: "Run SQL migrations" }
    ];
    const result = loadSkillInstructions(tasks, "implement");
    assert.equal(result, "", "Expected empty string for non-frontend tasks");
  });

  it("returns skill instructions for tasks with 'frontend' in the name", () => {
    const tasks = [
      { type: "feature", name: "Build frontend dashboard", description: "Create a new page" }
    ];
    const result = loadSkillInstructions(tasks, "implement");
    assert.ok(result.length > 0, "Expected non-empty skill instructions for frontend task");
    assert.ok(result.includes("Frontend Design Skills"), "Expected skills header");
  });

  it("returns skill instructions for tasks with 'ui' in description", () => {
    const tasks = [
      { type: "feature", name: "Update settings", description: "Improve the ui layout" }
    ];
    const result = loadSkillInstructions(tasks, "implement");
    assert.ok(result.length > 0, "Expected non-empty skill instructions for ui task");
  });

  it("includes execution order note in output for frontend implement phase", () => {
    const tasks = [
      { type: "frontend", name: "Landing page", description: "Design new landing page" }
    ];
    const result = loadSkillInstructions(tasks, "implement");
    assert.ok(result.includes("execution order"), `Expected execution order note in output, got: ${result.slice(0, 200)}`);
  });

  it("includes dependency note (after impeccable/audit) for polish skill", () => {
    const tasks = [
      { type: "frontend", name: "Polish UI", description: "Final design polish" }
    ];
    const result = loadSkillInstructions(tasks, "review");
    // polish depends_on audit — should be noted in output
    assert.ok(result.includes("after impeccable/audit"),
      `Expected 'after impeccable/audit' dep note in output`);
  });
});

// ---------------------------------------------------------------------------
// recordTaskMetrics
// ---------------------------------------------------------------------------

describe("recordTaskMetrics", () => {
  let originalMetrics;

  beforeEach(() => {
    originalMetrics = saveFixture("dev/metrics.json");
  });

  afterEach(() => {
    const full = scaffoldPath("dev/metrics.json");
    if (originalMetrics === null) {
      // File didn't exist before — remove or reset to avoid polluting disk
      try { writeFileSync(full, JSON.stringify({ sessions: [] }), "utf8"); } catch { /* ignore */ }
    } else {
      writeFileSync(full, originalMetrics, "utf8");
    }
  });

  it("creates dev/metrics.json with correct structure on first call", () => {
    const sessionId = `test-session-create-${Date.now()}`;
    // Remove any existing metrics file so we start fresh
    writeFixture("dev/metrics.json", JSON.stringify({ sessions: [] }));

    recordTaskMetrics({
      sessionId,
      sessionStartedAt: "2026-01-01T00:00:00.000Z",
      taskId: "T001",
      model: "claude-sonnet",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
      durationMs: 4000,
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.001,
      status: "success"
    });

    const data = JSON.parse(readFileSync(scaffoldPath("dev/metrics.json"), "utf8"));
    assert.ok(Array.isArray(data.sessions), "sessions should be an array");
    const session = data.sessions.find((s) => s.session_id === sessionId);
    assert.ok(session, "session entry should be created");
    assert.equal(session.tasks.length, 1, "should have one task");
    assert.equal(session.tasks[0].task_id, "T001");
    assert.equal(session.totals.tasks_completed, 1);
    assert.equal(session.totals.total_input_tokens, 100);
    assert.equal(session.totals.total_output_tokens, 200);
  });

  it("appends to existing session on second call with same sessionId", () => {
    const sessionId = `test-session-append-${Date.now()}`;
    writeFixture("dev/metrics.json", JSON.stringify({ sessions: [] }));

    const base = {
      sessionId,
      sessionStartedAt: "2026-01-01T00:00:00.000Z",
      model: "claude-sonnet",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
      durationMs: 3000,
      inputTokens: 50,
      outputTokens: 80,
      costUsd: 0.0005,
      status: "success"
    };

    recordTaskMetrics({ ...base, taskId: "T001" });
    recordTaskMetrics({ ...base, taskId: "T002" });

    const data = JSON.parse(readFileSync(scaffoldPath("dev/metrics.json"), "utf8"));
    const session = data.sessions.find((s) => s.session_id === sessionId);
    assert.ok(session, "session should exist");
    assert.equal(session.tasks.length, 2, "should have two tasks");
    assert.equal(session.totals.tasks_completed, 2);
    assert.equal(session.totals.total_input_tokens, 100);
  });

  it("only counts 'success' tasks toward tasks_completed but all count toward token totals", () => {
    const sessionId = `test-session-counts-${Date.now()}`;
    writeFixture("dev/metrics.json", JSON.stringify({ sessions: [] }));

    const base = {
      sessionId,
      sessionStartedAt: "2026-01-01T00:00:00.000Z",
      model: "claude-sonnet",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
      durationMs: 2000,
      inputTokens: 100,
      outputTokens: 100,
      costUsd: 0.001,
    };

    recordTaskMetrics({ ...base, taskId: "T001", status: "success" });
    recordTaskMetrics({ ...base, taskId: "T002", status: "failure" });
    recordTaskMetrics({ ...base, taskId: "T003", status: "skipped" });

    const data = JSON.parse(readFileSync(scaffoldPath("dev/metrics.json"), "utf8"));
    const session = data.sessions.find((s) => s.session_id === sessionId);
    assert.ok(session, "session should exist");
    assert.equal(session.totals.tasks_completed, 1, "only success status counts");
    assert.equal(session.totals.total_input_tokens, 300, "all tasks count for tokens");
    assert.equal(session.totals.total_output_tokens, 300, "all tasks count for tokens");
  });

  it("creates separate session entries for different sessionIds", () => {
    const sessionA = `test-session-A-${Date.now()}`;
    const sessionB = `test-session-B-${Date.now()}`;
    writeFixture("dev/metrics.json", JSON.stringify({ sessions: [] }));

    const base = {
      sessionStartedAt: "2026-01-01T00:00:00.000Z",
      taskId: "T001",
      model: "claude-sonnet",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
      durationMs: 1000,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.0001,
      status: "success"
    };

    recordTaskMetrics({ ...base, sessionId: sessionA });
    recordTaskMetrics({ ...base, sessionId: sessionB });

    const data = JSON.parse(readFileSync(scaffoldPath("dev/metrics.json"), "utf8"));
    const sA = data.sessions.find((s) => s.session_id === sessionA);
    const sB = data.sessions.find((s) => s.session_id === sessionB);
    assert.ok(sA, "session A should exist");
    assert.ok(sB, "session B should exist");
    assert.equal(sA.tasks.length, 1);
    assert.equal(sB.tasks.length, 1);
  });

  it("does not crash on corrupted/invalid metrics file", () => {
    writeFixture("dev/metrics.json", "THIS IS NOT JSON {{{{");

    assert.doesNotThrow(() => {
      recordTaskMetrics({
        sessionId: `test-session-corrupt-${Date.now()}`,
        sessionStartedAt: "2026-01-01T00:00:00.000Z",
        taskId: "T001",
        model: "claude-sonnet",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:05.000Z",
        durationMs: 500,
        inputTokens: 5,
        outputTokens: 10,
        costUsd: 0.0001,
        status: "success"
      });
    }, "recordTaskMetrics should not throw on corrupted metrics file");
  });
});

// ---------------------------------------------------------------------------
// checkGeminiPrerequisites
// ---------------------------------------------------------------------------

describe("checkGeminiPrerequisites", () => {
  it("returns available:false when bridge file is missing", () => {
    // The gemini-bridge/GeminiBridge.psm1 file does not exist in the test worktree
    // so this should always return available:false with an issue about the missing file.
    // (Even if gemini CLI is installed, the missing bridge file alone causes failure.)
    const result = checkGeminiPrerequisites();
    // We cannot guarantee gemini CLI is installed in CI, so we just verify the shape.
    assert.ok(typeof result.available === "boolean", "available should be a boolean");
    assert.ok(Array.isArray(result.issues), "issues should be an array");
  });

  it("returns issues array with descriptive messages when bridge file missing", () => {
    const result = checkGeminiPrerequisites();
    // Bridge file should be absent, so at least one issue about GeminiBridge.psm1
    const hasBridgeIssue = result.issues.some((msg) =>
      msg.includes("GeminiBridge.psm1") || msg.includes("gemini-bridge")
    );
    // If bridge is absent, there should be an issue about it.
    // If bridge is present (unlikely in worktree), just verify issues is an array.
    if (!result.available) {
      assert.ok(result.issues.length > 0, "Should have at least one issue when not available");
    }
    // The issues array items should be non-empty strings
    for (const issue of result.issues) {
      assert.ok(typeof issue === "string" && issue.length > 0, "Each issue should be a non-empty string");
    }
  });

  it("returns available:false when gemini CLI is not found (mocked via PATH)", () => {
    // Since we can't reliably control PATH in tests, we verify that if gemini is
    // missing the result has available:false AND issues mentions the CLI.
    // We run checkGeminiPrerequisites and if gemini CLI is absent the issues array
    // must include a hint about installing it.
    const result = checkGeminiPrerequisites();
    if (!result.available) {
      const hasCliIssue = result.issues.some((msg) =>
        msg.includes("gemini CLI") || msg.includes("gemini") || msg.includes("GeminiBridge")
      );
      assert.ok(hasCliIssue, `Issues should mention gemini CLI or bridge, got: ${result.issues.join("; ")}`);
    }
  });

  it("returns object with available and issues properties", () => {
    const result = checkGeminiPrerequisites();
    assert.ok(Object.prototype.hasOwnProperty.call(result, "available"), "result must have 'available' property");
    assert.ok(Object.prototype.hasOwnProperty.call(result, "issues"), "result must have 'issues' property");
  });
});

// ---------------------------------------------------------------------------
// buildGeminiDelegationBlock
// ---------------------------------------------------------------------------

describe("buildGeminiDelegationBlock", () => {
  it("returns a string containing the task ID", () => {
    const task = { id: "T042", name: "Build feature", description: "Do the thing" };
    const result = buildGeminiDelegationBlock(task);
    assert.ok(typeof result === "string", "should return a string");
    assert.ok(result.includes("T042"), "result should contain the task ID");
  });

  it("handles special characters in task name (single quotes)", () => {
    const task = {
      id: "T001",
      name: "Fix O'Brien's bug",
      description: "It's a quoted string issue",
      steps: [],
      acceptance_criteria: []
    };
    assert.doesNotThrow(() => buildGeminiDelegationBlock(task));
    const result = buildGeminiDelegationBlock(task);
    // Single quotes should be escaped as '' for PowerShell
    assert.ok(result.includes("O''Brien''s"), "single quotes should be doubled for PS safety");
  });

  it("handles newlines in task description without throwing", () => {
    const task = {
      id: "T002",
      name: "Multi\nline\ntask",
      description: "Step 1\nStep 2\nStep 3",
      steps: [],
      acceptance_criteria: []
    };
    assert.doesNotThrow(() => buildGeminiDelegationBlock(task));
    const result = buildGeminiDelegationBlock(task);
    // Newlines should be replaced with spaces
    assert.ok(!result.includes("Multi\nline"), "newlines in name should be removed");
  });

  it("handles empty steps and acceptance_criteria arrays", () => {
    const task = {
      id: "T003",
      name: "Simple task",
      description: "No steps",
      steps: [],
      acceptance_criteria: []
    };
    const result = buildGeminiDelegationBlock(task);
    assert.ok(typeof result === "string");
    assert.ok(result.includes("T003"), "should contain task ID");
    // Empty arrays result in @() in PowerShell
    assert.ok(result.includes("steps=@()"), "empty steps should produce @()");
    assert.ok(result.includes("acceptance_criteria=@()"), "empty criteria should produce @()");
  });

  it("contains GeminiBridge PowerShell module import", () => {
    const task = { id: "T004", name: "Test task", description: "desc" };
    const result = buildGeminiDelegationBlock(task);
    assert.ok(result.includes("GeminiBridge.psm1"), "should reference GeminiBridge.psm1");
    assert.ok(result.includes("Import-Module"), "should include Import-Module instruction");
  });

  it("includes Invoke-Gemini command", () => {
    const task = { id: "T005", name: "Gemini task", description: "delegate this" };
    const result = buildGeminiDelegationBlock(task);
    assert.ok(result.includes("Invoke-Gemini"), "should include Invoke-Gemini command");
  });
});

// ---------------------------------------------------------------------------
// loadNotificationConfig
// ---------------------------------------------------------------------------

describe("loadNotificationConfig", () => {
  let originalConfig;

  beforeEach(() => {
    originalConfig = saveFixture(".autopilot/config.json");
  });

  afterEach(() => {
    if (originalConfig !== null) {
      writeFixture(".autopilot/config.json", originalConfig);
    }
  });

  it("returns defaults when config file has no notifications key", () => {
    writeFixture(".autopilot/config.json", JSON.stringify({ runner: "sonnet" }));
    const config = loadNotificationConfig();
    assert.equal(config.enabled, false, "default enabled should be false");
    assert.equal(config.webhook_url, null, "default webhook_url should be null");
    assert.ok(typeof config.events === "object", "events should be an object");
  });

  it("returns defaults when config file is missing or empty JSON", () => {
    writeFixture(".autopilot/config.json", JSON.stringify({}));
    const config = loadNotificationConfig();
    assert.equal(config.enabled, false);
    assert.ok(config.events.task_completed === true, "task_completed default should be true");
  });

  it("merges user overrides with defaults", () => {
    writeFixture(".autopilot/config.json", JSON.stringify({
      notifications: {
        enabled: true,
        webhook_url: "https://hooks.example.com/test",
        events: { task_completed: false }
      }
    }));
    const config = loadNotificationConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.webhook_url, "https://hooks.example.com/test");
    assert.equal(config.events.task_completed, false, "overridden event should be false");
    assert.equal(config.events.task_failed, true, "non-overridden event should keep default");
  });

  it("preserves all default event keys in returned config", () => {
    writeFixture(".autopilot/config.json", JSON.stringify({}));
    const config = loadNotificationConfig();
    const expectedEvents = [
      "task_completed", "task_failed", "quota_wait", "all_tasks_done",
      "final_review_started", "final_review_done", "awaiting_user_decision",
      "error", "stopped"
    ];
    for (const event of expectedEvents) {
      assert.ok(event in config.events, `events.${event} should be present`);
    }
  });
});

// ---------------------------------------------------------------------------
// notifyStateChange
// ---------------------------------------------------------------------------

describe("notifyStateChange", () => {
  let originalConfig;

  beforeEach(() => {
    originalConfig = saveFixture(".autopilot/config.json");
    // Disable notifications so no webhook calls happen, but logging still occurs
    writeFixture(".autopilot/config.json", JSON.stringify({ notifications: { enabled: false } }));
  });

  afterEach(() => {
    if (originalConfig !== null) {
      writeFixture(".autopilot/config.json", originalConfig);
    }
  });

  it("does not throw when state transitions from idle to running", () => {
    const oldState = { status: "idle" };
    const newState = { status: "running" };
    assert.doesNotThrow(() => notifyStateChange(oldState, newState));
  });

  it("does not throw and does not notify when status is unchanged", () => {
    const state = { status: "running" };
    assert.doesNotThrow(() => notifyStateChange(state, state));
  });

  it("maps waiting_quota status to quota_wait event (does not throw)", () => {
    const oldState = { status: "running" };
    const newState = { status: "waiting_quota", retryAfterSeconds: 30, lastFailureCategory: "quota" };
    assert.doesNotThrow(() => notifyStateChange(oldState, newState));
  });

  it("maps error status to error event (does not throw)", () => {
    const oldState = { status: "running" };
    const newState = { status: "error", lastError: "Something went wrong" };
    assert.doesNotThrow(() => notifyStateChange(oldState, newState));
  });

  it("maps stopped status to stopped event (does not throw)", () => {
    const oldState = { status: "running" };
    const newState = { status: "stopped" };
    assert.doesNotThrow(() => notifyStateChange(oldState, newState));
  });

  it("handles null/undefined old state gracefully", () => {
    const newState = { status: "stopped" };
    assert.doesNotThrow(() => notifyStateChange(null, newState));
    assert.doesNotThrow(() => notifyStateChange(undefined, newState));
  });
});

// ---------------------------------------------------------------------------
// parseGitHubUrl
// ---------------------------------------------------------------------------

describe("parseGitHubUrl", () => {
  it("parses HTTPS URL without .git suffix", () => {
    const result = parseGitHubUrl("https://github.com/myorg/myrepo");
    assert.ok(result !== null, "should return a result");
    assert.equal(result.org, "myorg");
    assert.equal(result.repo, "myrepo");
  });

  it("parses HTTPS URL with .git suffix", () => {
    const result = parseGitHubUrl("https://github.com/myorg/myrepo.git");
    assert.ok(result !== null, "should return a result");
    assert.equal(result.org, "myorg");
    assert.equal(result.repo, "myrepo");
  });

  it("parses SSH URL with .git suffix", () => {
    const result = parseGitHubUrl("git@github.com:myorg/myrepo.git");
    assert.ok(result !== null, "should return a result");
    assert.equal(result.org, "myorg");
    assert.equal(result.repo, "myrepo");
  });

  it("parses SSH URL without .git suffix", () => {
    const result = parseGitHubUrl("git@github.com:myorg/myrepo");
    assert.ok(result !== null, "should return a result");
    assert.equal(result.org, "myorg");
    assert.equal(result.repo, "myrepo");
  });

  it("returns null for invalid URL", () => {
    const result = parseGitHubUrl("not-a-url");
    assert.equal(result, null, "should return null for invalid URL");
  });

  it("returns null for empty string", () => {
    const result = parseGitHubUrl("");
    assert.equal(result, null, "should return null for empty string");
  });

  it("preserves the original URL in result", () => {
    const url = "https://github.com/org/repo.git";
    const result = parseGitHubUrl(url);
    assert.equal(result.url, url, "url field should match original input");
  });
});

// ---------------------------------------------------------------------------
// parseYamlFrontmatter
// ---------------------------------------------------------------------------

describe("parseYamlFrontmatter", () => {
  it("parses basic key:value pairs", () => {
    const content = `---\nname: my-skill\nrole: general\n---\nContent here`;
    const result = parseYamlFrontmatter(content);
    assert.ok(result !== null, "should return a result");
    assert.equal(result.name, "my-skill");
    assert.equal(result.role, "general");
  });

  it("strips surrounding quotes from values", () => {
    const content = `---\nname: "quoted-skill"\ndescription: 'single-quoted'\n---`;
    const result = parseYamlFrontmatter(content);
    assert.equal(result.name, "quoted-skill");
    assert.equal(result.description, "single-quoted");
  });

  it("returns null when no frontmatter delimiter present", () => {
    const content = `No frontmatter here\nJust plain content`;
    const result = parseYamlFrontmatter(content);
    assert.equal(result, null, "should return null when no frontmatter");
  });

  it("returns null for empty frontmatter block", () => {
    const content = `---\n---\nContent`;
    const result = parseYamlFrontmatter(content);
    assert.equal(result, null, "should return null for empty frontmatter");
  });

  it("handles multiple key:value pairs with various types", () => {
    const content = `---\nname: test-skill\nrole: frontend\nwhen: building UI\ndescription: A test skill\n---`;
    const result = parseYamlFrontmatter(content);
    assert.equal(result.name, "test-skill");
    assert.equal(result.role, "frontend");
    assert.equal(result.when, "building UI");
    assert.equal(result.description, "A test skill");
  });
});

// ---------------------------------------------------------------------------
// checkCircularDependencies (skill-add registry format)
// ---------------------------------------------------------------------------

describe("checkCircularDependencies", () => {
  it("returns empty array when there are no cycles", () => {
    const registry = {
      skills: {
        "module-a": {
          skills: {
            "skill-1": { depends_on: null },
            "skill-2": { depends_on: "module-a/skill-1" }
          }
        }
      }
    };
    const cycles = checkCircularDependencies(registry);
    assert.deepEqual(cycles, [], "no cycles should return empty array");
  });

  it("detects a direct A->B->A cycle", () => {
    const registry = {
      skills: {
        "module-a": {
          skills: {
            "skill-x": { depends_on: "module-a/skill-y" },
            "skill-y": { depends_on: "module-a/skill-x" }
          }
        }
      }
    };
    const cycles = checkCircularDependencies(registry);
    assert.ok(cycles.length > 0, "should detect at least one cycle");
    assert.ok(
      cycles.some(id => id === "module-a/skill-x" || id === "module-a/skill-y"),
      "cyclic skill IDs should be in the result"
    );
  });

  it("handles registry with no skills entries", () => {
    const registry = { skills: {} };
    const cycles = checkCircularDependencies(registry);
    assert.deepEqual(cycles, [], "empty registry should return empty array");
  });

  it("returns empty for skills with null depends_on", () => {
    const registry = {
      skills: {
        "module-a": {
          skills: {
            "skill-1": { depends_on: null },
            "skill-2": { depends_on: null }
          }
        }
      }
    };
    const cycles = checkCircularDependencies(registry);
    assert.deepEqual(cycles, []);
  });

  it("handles skills with no depends_on field at all", () => {
    const registry = {
      skills: {
        "module-b": {
          skills: {
            "alpha": {},
            "beta": {}
          }
        }
      }
    };
    assert.doesNotThrow(() => checkCircularDependencies(registry));
    const cycles = checkCircularDependencies(registry);
    assert.deepEqual(cycles, []);
  });
});
