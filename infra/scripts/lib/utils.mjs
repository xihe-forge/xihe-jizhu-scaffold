import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";

export const rootDir = process.cwd();

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
  writeFileSync(resolvePath(relativePath), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function readText(relativePath, fallback = "") {
  try {
    return readFileSync(resolvePath(relativePath), "utf8");
  } catch {
    return fallback;
  }
}

export function writeText(relativePath, content) {
  writeFileSync(resolvePath(relativePath), content, "utf8");
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
