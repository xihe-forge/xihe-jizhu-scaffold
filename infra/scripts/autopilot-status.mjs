import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";
const DIM    = "\x1b[2m";

function green(s)  { return `${GREEN}${s}${RESET}`; }
function yellow(s) { return `${YELLOW}${s}${RESET}`; }
function red(s)    { return `${RED}${s}${RESET}`; }
function cyan(s)   { return `${CYAN}${s}${RESET}`; }
function bold(s)   { return `${BOLD}${s}${RESET}`; }
function dim(s)    { return `${DIM}${s}${RESET}`; }

// ─── File helpers (no external deps) ─────────────────────────────────────────

const rootDir = process.cwd();

function resolvePath(rel) {
  return path.isAbsolute(rel) ? rel : path.join(rootDir, rel);
}

function readJson(rel, fallback = null) {
  try {
    return JSON.parse(readFileSync(resolvePath(rel), "utf8"));
  } catch {
    return fallback;
  }
}

function readText(rel, fallback = "") {
  try {
    return readFileSync(resolvePath(rel), "utf8");
  } catch {
    return fallback;
  }
}

function pathExists(rel) {
  return existsSync(resolvePath(rel));
}

/** Return the last N non-empty lines of a multi-line string. */
function lastLines(text, n) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-n);
}

// ─── Progress bar renderer ────────────────────────────────────────────────────

const BAR_WIDTH = 20; // characters

function progressBar(done, total) {
  if (total === 0) {
    return `[${"░".repeat(BAR_WIDTH)}] 0/0 tasks done`;
  }
  const ratio   = Math.min(1, done / total);
  const filled  = Math.round(ratio * BAR_WIDTH);
  const empty   = BAR_WIDTH - filled;
  const bar     = green("█".repeat(filled)) + dim("░".repeat(empty));
  return `[${bar}] ${done}/${total} tasks done`;
}

// ─── Quota status ─────────────────────────────────────────────────────────────

/**
 * Determine quota health from autopilot state.
 * If status is "quota_wait", try to parse reset time from lastFailureHint.
 */
function quotaLine(state) {
  if (!state) return dim("Quota: unknown");

  const status = state.status ?? "";

  if (status === "quota_wait") {
    const hint = state.lastFailureHint ?? "";
    // look for "resets HH:MM am/pm" pattern
    const match = hint.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/iu);
    if (match) {
      let hour   = Number(match[1]);
      const min  = Number(match[2] ?? 0);
      const mer  = match[3].toLowerCase();
      if (mer === "pm" && hour !== 12) hour += 12;
      if (mer === "am" && hour === 12) hour = 0;

      const now     = new Date();
      const resetAt = new Date(now);
      resetAt.setHours(hour, min, 0, 0);
      if (resetAt <= now) resetAt.setDate(resetAt.getDate() + 1);

      const secLeft = Math.max(0, Math.ceil((resetAt - now) / 1000));
      const mLeft   = Math.floor(secLeft / 60);
      const sLeft   = secLeft % 60;
      const humanLeft = mLeft > 0 ? `${mLeft}m ${sLeft}s` : `${sLeft}s`;
      return yellow(`Quota: waiting (resets in ${humanLeft})`);
    }
    return yellow("Quota: waiting (reset time unknown)");
  }

  return green("Quota: OK");
}

// ─── Status colorizer ─────────────────────────────────────────────────────────

function colorStatus(status) {
  if (!status) return dim("unknown");
  if (status === "running" || status === "done" || status === "success") return green(status);
  if (status === "quota_wait" || status === "in_progress" || status === "waiting") return yellow(status);
  if (status === "error" || status === "failed") return red(status);
  return cyan(status);
}

// ─── Dashboard renderer ───────────────────────────────────────────────────────

function render() {
  const state   = readJson(".autopilot/state.json", null);
  const tasks   = readJson("dev/task.json", null);
  const progressText = readText("dev/progress.txt");
  const logText      = readText(".autopilot/logs/autopilot.log");

  // ── Task progress
  const allTasks  = tasks?.tasks ?? [];
  const total     = allTasks.length;
  const done      = allTasks.filter((t) => t.status === "done").length;
  const inProg    = allTasks.filter((t) => t.status === "in_progress").length;

  // ── Current task name from state
  const currentTaskId   = state?.lastTaskId ?? null;
  const currentTaskObj  = allTasks.find((t) => t.id === currentTaskId) ?? null;
  const currentTaskName = currentTaskObj ? `${currentTaskId}: ${currentTaskObj.name}` : (currentTaskId ?? "(none)");

  // ── Lines
  const recentProgress = lastLines(progressText, 5);
  const recentLog      = lastLines(logText, 5);

  // ── Render
  const lines = [];

  lines.push("");
  lines.push(bold("╔══════════════════════════════════════════════════════╗"));
  lines.push(bold("║          Autopilot Dashboard                         ║"));
  lines.push(bold("╚══════════════════════════════════════════════════════╝"));
  lines.push("");

  // Status row
  const statusVal = state?.status ?? "not started";
  const round     = state?.round ?? 0;
  lines.push(`  ${bold("Status:")} ${colorStatus(statusVal)}  ${bold("Task:")} ${cyan(currentTaskId ?? "—")}  ${bold("Round:")} ${round}`);
  lines.push("");

  // Quota
  lines.push(`  ${quotaLine(state)}`);
  lines.push("");

  // Progress bar
  lines.push(`  ${progressBar(done, total)}`);
  if (inProg > 0) {
    lines.push(`  ${yellow(`${inProg} task(s) in progress`)}`);
  }
  lines.push("");

  // Current task detail
  if (currentTaskObj) {
    lines.push(`  ${bold("Current task:")} ${currentTaskName}`);
    lines.push(`  ${bold("Phase:")}        ${currentTaskObj.phase ?? "—"}`);
    lines.push(`  ${bold("Priority:")}     ${currentTaskObj.priority ?? "—"}`);
    lines.push("");
  }

  // Recent activity (dev/progress.txt)
  lines.push(`  ${bold("Recent activity:")} ${dim("(dev/progress.txt)")}`);
  if (recentProgress.length === 0) {
    lines.push(`  ${dim("  (no entries yet)")}`);
  } else {
    for (const line of recentProgress) {
      lines.push(`  ${dim("  " + line)}`);
    }
  }
  lines.push("");

  // Recent log entries
  lines.push(`  ${bold("Recent log:")} ${dim("(.autopilot/logs/autopilot.log)")}`);
  if (recentLog.length === 0) {
    lines.push(`  ${dim("  (no log entries yet)")}`);
  } else {
    for (const line of recentLog) {
      lines.push(`  ${dim("  " + line)}`);
    }
  }
  lines.push("");

  // Footer
  const updatedAt = state?.updatedAt ?? null;
  if (updatedAt) {
    lines.push(`  ${dim("State last updated: " + updatedAt)}`);
  }

  const now = new Date().toISOString();
  lines.push(`  ${dim("Dashboard rendered: " + now)}`);
  lines.push("");

  process.stdout.write(lines.join("\n") + "\n");
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const watchFlag = process.argv.includes("--watch");
const REFRESH_MS = 5_000;

if (watchFlag) {
  // Initial render
  console.clear();
  render();

  setInterval(() => {
    console.clear();
    render();
  }, REFRESH_MS);

  // Keep process alive; Ctrl-C exits.
  process.on("SIGINT", () => {
    process.stdout.write("\n");
    process.exit(0);
  });
} else {
  render();
}
