import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";

export const rootDir = process.cwd();

// --- File Locking ---

const LOCK_STALE_TIMEOUT_MS = 30_000; // 30 seconds
const LOCK_RETRY_COUNT = 10;
const LOCK_RETRY_DELAY_MS = 100;

/** Set of lock file paths currently held by this process, for cleanup on exit. */
const heldLocks = new Set();

function registerExitCleanup() {
  if (registerExitCleanup._registered) return;
  registerExitCleanup._registered = true;

  const cleanup = () => {
    for (const lockPath of heldLocks) {
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
  process.on("uncaughtException", (err) => { cleanup(); throw err; });
}

registerExitCleanup();

/**
 * Acquire a lockfile for the given absolute path, retrying up to LOCK_RETRY_COUNT times.
 * Returns the lock file path on success, throws on failure.
 */
function acquireLock(absolutePath) {
  const lockPath = `${absolutePath}.lock`;

  for (let attempt = 0; attempt <= LOCK_RETRY_COUNT; attempt++) {
    // Clear stale lock
    if (existsSync(lockPath)) {
      let stale = false;
      try {
        const stat = statSync(lockPath);
        stale = Date.now() - stat.mtimeMs > LOCK_STALE_TIMEOUT_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        try { unlinkSync(lockPath); } catch { /* ignore */ }
      }
    }

    // Attempt atomic creation
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      heldLocks.add(lockPath);
      return lockPath;
    } catch (err) {
      if (err.code !== "EEXIST" || attempt === LOCK_RETRY_COUNT) {
        throw new Error(`Could not acquire lock for ${absolutePath} after ${attempt} attempts: ${err.message}`);
      }
      // Synchronous sleep via a busy-wait is avoided; we use a short Atomics wait instead.
      const sharedBuffer = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sharedBuffer), 0, 0, LOCK_RETRY_DELAY_MS);
    }
  }
}

/**
 * Release a previously acquired lockfile.
 */
function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
  heldLocks.delete(lockPath);
}

/**
 * Execute callback while holding an exclusive lockfile for filePath.
 * filePath may be absolute or relative (resolved via resolvePath).
 */
export function withFileLock(filePath, callback) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
  const lockPath = acquireLock(absolutePath);
  try {
    return callback();
  } finally {
    releaseLock(lockPath);
  }
}

export function resolvePath(relativePath) {
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }

  return path.join(rootDir, relativePath);
}

export function ensureDir(relativePath) {
  mkdirSync(resolvePath(relativePath), { recursive: true });
}

export function pathExists(relativePath) {
  return existsSync(resolvePath(relativePath));
}

export function readJson(relativePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(resolvePath(relativePath), "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(relativePath, data) {
  const absolutePath = resolvePath(relativePath);
  withFileLock(absolutePath, () => {
    writeFileSync(absolutePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  });
}

export function readText(relativePath, fallback = "") {
  try {
    return readFileSync(resolvePath(relativePath), "utf8");
  } catch {
    return fallback;
  }
}

export function writeText(relativePath, content) {
  const absolutePath = resolvePath(relativePath);
  withFileLock(absolutePath, () => {
    writeFileSync(absolutePath, content, "utf8");
  });
}

export function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function looksLikeFilePath(command) {
  return /[\\/]/u.test(command) || /^[a-z]:/iu.test(command);
}

function resolveWindowsCommand(command) {
  const result = spawnSync("where.exe", [command], {
    stdio: "pipe",
    shell: false,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    return null;
  }

  const matches = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  const preferredOrder = [".cmd", ".bat", ".exe", ""];
  for (const extension of preferredOrder) {
    const match = matches.find((entry) => entry.toLowerCase().endsWith(extension));
    if (match) {
      return match;
    }
  }

  return matches[0] ?? null;
}

export function getExecutable(command) {
  if (command === "node") {
    return process.execPath;
  }

  if (looksLikeFilePath(command)) {
    return command;
  }

  if (process.platform !== "win32") {
    return command;
  }

  if (command.endsWith(".exe") || command.endsWith(".cmd")) {
    return command;
  }

  const resolved = resolveWindowsCommand(command);
  if (resolved) {
    return resolved;
  }

  return `${command}.cmd`;
}

export function requiresCommandShell(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/iu.test(command);
}

function quoteShellArg(arg) {
  const value = String(arg ?? "");
  if (!value) {
    return "\"\"";
  }

  if (/[^\w./:-]/u.test(value)) {
    return `"${value.replace(/"/gu, '\\"')}"`;
  }

  return value;
}

export function buildShellCommandLine(command, args = []) {
  return [quoteShellArg(command), ...(args ?? []).map(quoteShellArg)].join(" ").trim();
}

export function runCommand(command, args, options = {}) {
  const executable = getExecutable(command);
  const baseOptions = {
    cwd: options.cwd ?? rootDir,
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env
  };

  if (options.shell ?? requiresCommandShell(executable)) {
    return spawnSync(buildShellCommandLine(executable, args), {
      ...baseOptions,
      shell: true
    });
  }

  return spawnSync(executable, args, {
    ...baseOptions,
    shell: false
  });
}

export function commandExists(command) {
  if (!command) {
    return false;
  }

  if (looksLikeFilePath(command)) {
    return existsSync(command);
  }

  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], {
    stdio: "ignore",
    shell: false
  });

  return result.status === 0;
}

export async function withReadline(callback) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    return await callback(rl);
  } finally {
    rl.close();
  }
}

export async function promptText(rl, label, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue;
}

export async function promptNumber(rl, label, defaultValue) {
  const answer = await promptText(rl, label, String(defaultValue));
  const parsed = Number(answer);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export async function promptYesNo(rl, label, defaultValue = true) {
  const suffix = defaultValue ? " [Y/n]" : " [y/N]";
  const answer = (await rl.question(`${label}${suffix}: `)).trim().toLowerCase();

  if (!answer) {
    return defaultValue;
  }

  return answer === "y" || answer === "yes";
}

export async function promptChoice(rl, label, choices, defaultIndex = 0) {
  console.log(label);
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice}`);
  });

  const answer = await promptText(rl, "Choose", String(defaultIndex + 1));
  const selectedIndex = Number(answer) - 1;

  if (selectedIndex >= 0 && selectedIndex < choices.length) {
    return selectedIndex;
  }

  return defaultIndex;
}

export function replaceMarkdownSection(markdown, heading, body) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(## ${escapedHeading}\\n\\n)([\\s\\S]*?)(?=\\n## |$)`, "m");
  const replacement = `$1${body.trim()}\n`;
  if (pattern.test(markdown)) {
    return markdown.replace(pattern, replacement);
  }

  return `${markdown.trim()}\n\n## ${heading}\n\n${body.trim()}\n`;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
}

export function parseQuotaResetWaitSeconds(text, now = new Date()) {
  const normalized = String(text ?? "");
  const match = normalized.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/iu);

  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3].toLowerCase();

  if (meridiem === "pm" && hour !== 12) {
    hour += 12;
  }
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  const resetAt = new Date(now);
  resetAt.setHours(hour, minute, 0, 0);

  if (resetAt.getTime() <= now.getTime()) {
    resetAt.setDate(resetAt.getDate() + 1);
  }

  return Math.max(0, Math.ceil((resetAt.getTime() - now.getTime()) / 1000) + 60);
}
