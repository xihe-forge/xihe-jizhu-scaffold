import { readJson, writeJson, pathExists, ensureDir } from "./utils.mjs";
import path from "node:path";

const MEMORY_PATH = ".autopilot/memory.json";
const MAX_MEMORY_ITEMS = 50;

/**
 * Returns an empty memory structure.
 */
function emptyMemory() {
  return {
    version: "1.0",
    lastUpdated: new Date().toISOString(),
    projectDecisions: [],
    executionPatterns: [],
    taskNotes: [],
    _agentStats: {}
  };
}

/**
 * Generate a simple sequential ID for a memory category.
 */
function generateId(prefix, existingItems) {
  const count = existingItems.length + 1;
  return `${prefix}_${String(count).padStart(3, "0")}`;
}

/**
 * Load memory from disk. Returns empty structure if file doesn't exist.
 */
export function loadMemory() {
  if (!pathExists(MEMORY_PATH)) {
    return emptyMemory();
  }
  try {
    const data = readJson(MEMORY_PATH);
    // Ensure all required keys exist (forward-compatible)
    return {
      version: data.version ?? "1.0",
      lastUpdated: data.lastUpdated ?? new Date().toISOString(),
      projectDecisions: Array.isArray(data.projectDecisions) ? data.projectDecisions : [],
      executionPatterns: Array.isArray(data.executionPatterns) ? data.executionPatterns : [],
      taskNotes: Array.isArray(data.taskNotes) ? data.taskNotes : [],
      _agentStats: data._agentStats && typeof data._agentStats === "object" ? data._agentStats : {}
    };
  } catch {
    return emptyMemory();
  }
}

/**
 * Save memory to disk (atomic via writeJson).
 */
export function saveMemory(memory) {
  ensureDir(path.dirname(MEMORY_PATH));
  const updated = { ...memory, lastUpdated: new Date().toISOString() };
  writeJson(MEMORY_PATH, updated);
}

/**
 * Extract memorable items from agent output after a successful task.
 * Looks for specific patterns in the output text:
 * - "DECISION:" lines → projectDecisions
 * - "NOTE:" lines → taskNotes
 * - Timeout/failure patterns → executionPatterns
 * Returns { decisions: [], patterns: [], notes: [] }
 */
export function extractMemoryFromOutput(output, taskId, round) {
  const decisions = [];
  const patterns = [];
  const notes = [];

  if (!output || typeof output !== "string") {
    return { decisions, patterns, notes };
  }

  const lines = output.split(/\r?\n/);
  const now = new Date().toISOString();

  for (const line of lines) {
    const trimmed = line.trim();

    // Match DECISION: or 决策:
    const decisionMatch = trimmed.match(/^(?:DECISION|决策)\s*[:：]\s*(.+)/iu);
    if (decisionMatch) {
      const content = decisionMatch[1].trim();
      if (content) {
        decisions.push({ content, source: taskId, round, createdAt: now });
      }
      continue;
    }

    // Match NOTE: or 注意:
    const noteMatch = trimmed.match(/^(?:NOTE|注意)\s*[:：]\s*(.+)/iu);
    if (noteMatch) {
      const content = noteMatch[1].trim();
      if (content) {
        notes.push({ taskId, content, round, createdAt: now });
      }
      continue;
    }
  }

  // Check for timeout patterns in the full output
  if (/\btimed?\s*out\b|\btimeout\b/i.test(output)) {
    patterns.push({
      content: `Task ${taskId} experienced a timeout — consider assigning to a different agent`,
      confidence: 0.7,
      createdAt: now
    });
  }

  return { decisions, patterns, notes };
}

/**
 * Add extracted items to memory, deduplicating by content similarity.
 * Trims each category to MAX_MEMORY_ITEMS (oldest removed first).
 */
export function updateMemory(memory, extracted) {
  const { decisions = [], patterns = [], notes = [] } = extracted;
  const updated = { ...memory };

  // Helper: deduplicate by exact content match or by _key field
  function addUnique(existing, newItems, idPrefix) {
    const existingContents = new Set(existing.map((item) => item.content));
    const existingKeys = new Set(existing.map((item) => item._key).filter(Boolean));
    const merged = [...existing];
    for (const item of newItems) {
      const hasKeyConflict = item._key && existingKeys.has(item._key);
      const hasContentConflict = existingContents.has(item.content);
      if (!hasKeyConflict && !hasContentConflict) {
        const id = generateId(idPrefix, merged);
        merged.push({ id, ...item });
        existingContents.add(item.content);
        if (item._key) existingKeys.add(item._key);
      }
    }
    // Trim to MAX_MEMORY_ITEMS — remove oldest (from the front)
    return merged.length > MAX_MEMORY_ITEMS
      ? merged.slice(merged.length - MAX_MEMORY_ITEMS)
      : merged;
  }

  updated.projectDecisions = addUnique(updated.projectDecisions, decisions, "dec");
  updated.executionPatterns = addUnique(updated.executionPatterns, patterns, "pat");
  updated.taskNotes = addUnique(updated.taskNotes, notes, "note");

  return updated;
}

/**
 * Format memory for injection into agent system prompt.
 * Returns a string block like:
 * <project_memory>
 * ## Project Decisions
 * - [T003] 使用zustand而非Redux
 * ## Execution Patterns
 * - codex对此项目timeout率高
 * ## Recent Task Notes
 * - [T007] 需要先装依赖再跑测试
 * </project_memory>
 *
 * Returns empty string if no memories exist.
 */
export function formatMemoryForPrompt(memory) {
  const decisions = memory.projectDecisions ?? [];
  const patterns = memory.executionPatterns ?? [];
  const notes = memory.taskNotes ?? [];

  if (decisions.length === 0 && patterns.length === 0 && notes.length === 0) {
    return "";
  }

  const lines = ["<project_memory>"];

  if (decisions.length > 0) {
    lines.push("## Project Decisions");
    for (const d of decisions) {
      const tag = d.source ? `[${d.source}] ` : "";
      lines.push(`- ${tag}${d.content}`);
    }
  }

  if (patterns.length > 0) {
    lines.push("## Execution Patterns");
    for (const p of patterns) {
      lines.push(`- ${p.content}`);
    }
  }

  if (notes.length > 0) {
    lines.push("## Recent Task Notes");
    for (const n of notes) {
      const tag = n.taskId ? `[${n.taskId}] ` : "";
      lines.push(`- ${tag}${n.content}`);
    }
  }

  lines.push("</project_memory>");
  return lines.join("\n");
}

/**
 * Record a task execution outcome for pattern learning.
 * Called after each task completes or fails.
 * Tracks per-assignee success/failure/timeout rates and generates a pattern
 * suggestion when an assignee has 3+ consecutive failures.
 */
export function recordTaskOutcome(memory, taskId, assignee, outcome, durationMs) {
  if (!assignee) return memory;

  const updated = { ...memory };
  const stats = { ...(updated._agentStats ?? {}) };

  if (!stats[assignee]) {
    stats[assignee] = { success: 0, failure: 0, timeout: 0, consecutiveFailures: 0 };
  }

  const agentStat = { ...stats[assignee] };

  if (outcome === "success") {
    agentStat.success += 1;
    agentStat.consecutiveFailures = 0;
  } else if (outcome === "timeout") {
    agentStat.timeout += 1;
    agentStat.consecutiveFailures += 1;
  } else {
    // failure or any other non-success outcome
    agentStat.failure += 1;
    agentStat.consecutiveFailures += 1;
  }

  stats[assignee] = agentStat;
  updated._agentStats = stats;

  // Auto-generate pattern if consecutiveFailures >= 3
  if (agentStat.consecutiveFailures >= 3) {
    // Use a stable content key (not including the count) to avoid duplicates as
    // the failure count grows beyond 3.
    const patternKey = `${assignee} consecutive-failure-warning`;
    const patternContent = `${assignee} has failed ${agentStat.consecutiveFailures} times consecutively on this project — consider switching to an alternative agent`;

    const existingIndex = (updated.executionPatterns ?? []).findIndex(
      (p) => p._key === patternKey
    );

    if (existingIndex === -1) {
      // First time — add via updateMemory so the id/trimming logic applies
      const extracted = {
        decisions: [],
        patterns: [{ content: patternContent, confidence: 0.9, createdAt: new Date().toISOString(), _key: patternKey }],
        notes: []
      };
      return updateMemory(updated, extracted);
    } else {
      // Already exists — update in place with the new count
      const newPatterns = [...updated.executionPatterns];
      newPatterns[existingIndex] = {
        ...newPatterns[existingIndex],
        content: patternContent
      };
      updated.executionPatterns = newPatterns;
    }
  }

  return updated;
}
