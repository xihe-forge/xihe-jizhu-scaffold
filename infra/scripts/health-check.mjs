import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const requiredPaths = [
  "apps/web/package.json",
  "apps/api/package.json",
  "packages/shared/package.json",
  "packages/types/package.json",
  ".planning/config.json",
  ".autopilot/config.json",
  ".planning/PROJECT.md",
  ".planning/ROADMAP.md",
  "dev/task.json",
  "dev/progress.txt",
  "README.md"
];

const missing = requiredPaths.filter((relativePath) => !existsSync(path.join(root, relativePath)));

const issues = [];

function parseJson(relativePath) {
  try {
    const file = readFileSync(path.join(root, relativePath), "utf8");
    return JSON.parse(file);
  } catch (error) {
    issues.push(`Invalid JSON: ${relativePath} (${error.message})`);
    return null;
  }
}

const config = parseJson(".planning/config.json");
const taskFile = parseJson("dev/task.json");

if (config && typeof config.workflow !== "object") {
  issues.push("Missing workflow section in .planning/config.json");
}

if (taskFile && !Array.isArray(taskFile.tasks)) {
  issues.push("dev/task.json must contain a tasks array");
}

if (missing.length > 0) {
  for (const entry of missing) {
    issues.push(`Missing required path: ${entry}`);
  }
}

if (issues.length > 0) {
  console.error("Health check failed:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

const taskCount = Array.isArray(taskFile?.tasks) ? taskFile.tasks.length : 0;

console.log("Health check passed.");
console.log(`Required paths: ${requiredPaths.length}`);
console.log(`Tasks tracked: ${taskCount}`);
