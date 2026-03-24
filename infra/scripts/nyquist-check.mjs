/**
 * Nyquist Validation: Requirement-to-Test Traceability
 *
 * Checks that every acceptance criterion in a "done" task is covered by
 * either a `tested_by` field in task.json OR a test file that references
 * the task ID / criterion text.
 *
 * Exit code 0 = all done tasks have full coverage
 * Exit code 1 = gaps found
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJson(relativePath) {
  const full = path.join(root, relativePath);
  if (!existsSync(full)) {
    console.error(`File not found: ${relativePath}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(full, "utf8"));
}

/** Recursively collect all files under a directory. */
function collectFiles(dir, collected = []) {
  if (!existsSync(dir)) return collected;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, collected);
    } else {
      collected.push(full);
    }
  }
  return collected;
}

/** Read all test file contents once (lazy cache). */
function buildTestCorpus(testDir) {
  const files = collectFiles(testDir);
  return files.map((filePath) => {
    try {
      return { filePath, content: readFileSync(filePath, "utf8") };
    } catch {
      return { filePath, content: "" };
    }
  });
}

/**
 * Return true if the criterion is covered by any of:
 *   1. A `tested_by` field on the criterion itself (object form).
 *   2. A test file mentioning the task ID.
 *   3. A test file mentioning a significant fragment of the criterion text.
 */
function isCovered(criterion, taskId, testCorpus) {
  // Form 1: criterion is an object with a tested_by field
  if (typeof criterion === "object" && criterion !== null && criterion.tested_by) {
    return true;
  }

  const text = typeof criterion === "object" ? criterion.text : criterion;

  // Form 2 & 3: search test files
  const assertionPattern = /\bassert\b|\.expect\b|expect\(|\.toBe\b|\.toEqual\b|\btest\(|\bit\(|\bdescribe\(/;
  for (const { content } of testCorpus) {
    // Task ID mention (e.g. "T005") — only counts if the file also contains real assertions
    if (content.includes(taskId) && assertionPattern.test(content)) {
      // The file mentions this task and has assertions — consider it covering all criteria for the task
      return true;
    }
    // Criterion text fragment: use the first 40 chars (trimmed) as a fingerprint
    const fragment = text.trim().slice(0, 40);
    if (fragment.length >= 8 && content.includes(fragment)) {
      return true;
    }
  }

  return false;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const taskFile = readJson("dev/task.json");
const testCorpus = buildTestCorpus(path.join(root, "test"));

const doneTasks = taskFile.tasks.filter((t) => t.status === "done");

console.log("Nyquist Validation Report");
console.log("========================");

if (doneTasks.length === 0) {
  console.log("No done tasks found — nothing to validate.");
  process.exit(0);
}

let hasGaps = false;

for (const task of doneTasks) {
  const criteria = task.acceptance_criteria ?? [];

  if (criteria.length === 0) {
    console.log(`${task.id} (done): no acceptance criteria defined — skipping`);
    continue;
  }

  const uncovered = [];

  for (const criterion of criteria) {
    if (!isCovered(criterion, task.id, testCorpus)) {
      const text = typeof criterion === "object" ? criterion.text : criterion;
      uncovered.push(text);
    }
  }

  const covered = criteria.length - uncovered.length;
  const symbol = uncovered.length === 0 ? "✓" : "✗";

  console.log(`${task.id} (done): ${covered}/${criteria.length} criteria covered ${symbol}`);

  if (uncovered.length > 0) {
    hasGaps = true;
    for (const text of uncovered) {
      console.log(`  - UNCOVERED: "${text}"`);
    }
  }
}

console.log("");

if (hasGaps) {
  console.log(
    "Result: GAPS FOUND — add tested_by fields or test files referencing the task IDs above.",
  );
  process.exit(1);
} else {
  console.log("Result: All done tasks have full criterion coverage.");
  process.exit(0);
}
