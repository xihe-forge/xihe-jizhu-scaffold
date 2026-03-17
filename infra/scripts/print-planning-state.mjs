import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

const project = read(".planning/PROJECT.md");
const roadmap = read(".planning/ROADMAP.md");
const state = read(".planning/STATE.md");
const tasks = JSON.parse(read("dev/task.json"));

function extractProjectName(markdown) {
  const lines = markdown.split("\n");
  const nameIndex = lines.findIndex((line) => line.trim() === "## Name");

  if (nameIndex === -1) {
    return "Project name not found";
  }

  for (let index = nameIndex + 1; index < lines.length; index += 1) {
    const candidate = lines[index].trim();
    if (candidate.length > 0) {
      return candidate;
    }
  }

  return "Project name not found";
}

const counts = new Map();
for (const task of tasks.tasks) {
  counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
}

console.log("Planning status");
console.log("================");
console.log(extractProjectName(project));
console.log("");
console.log("Task counts:");
for (const [status, count] of counts.entries()) {
  console.log(`- ${status}: ${count}`);
}
console.log("");
console.log("Roadmap preview:");
console.log(roadmap.split("\n").slice(0, 8).join("\n"));
console.log("");
console.log("State preview:");
console.log(state.split("\n").slice(0, 10).join("\n"));
