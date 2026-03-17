import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectFailureCategory,
  getTaskProgressSummary,
  getReadyTasks,
  buildPrompt
} from "../../infra/scripts/autopilot-start.mjs";

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
    // File didn't exist before — leave it (test runner already replaced it)
    // We overwrite with empty tasks so state is clean
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
});
