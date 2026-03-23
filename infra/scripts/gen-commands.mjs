import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

const commandsDir = path.resolve(".", ".claude", "commands");

let preamble;
try {
  preamble = readFileSync(path.join(commandsDir, "preamble.md"), "utf8");
} catch (err) {
  console.error(`FAIL: could not read preamble.md from ${commandsDir} — ${err.message}`);
  console.error("Ensure .claude/commands/preamble.md exists. Run pnpm kickoff to initialize.");
  process.exit(1);
}

const templates = readdirSync(commandsDir).filter(f => f.endsWith(".md.tmpl"));

for (const tmpl of templates) {
  const tmplPath = path.join(commandsDir, tmpl);
  let content = readFileSync(tmplPath, "utf8");
  if (!content.includes("{{PREAMBLE}}")) {
    console.warn(`WARN: template "${tmpl}" does not contain {{PREAMBLE}} placeholder — preamble will not be injected`);
  }
  content = content.replaceAll("{{PREAMBLE}}", preamble);
  const header = "<!-- GENERATED FILE — edit the .md.tmpl source, then run: pnpm gen:commands -->\n";
  writeFileSync(path.join(commandsDir, tmpl.replace(".md.tmpl", ".md")), header + content, "utf8");
  console.log(`Generated: ${tmpl.replace(".md.tmpl", ".md")}`);
}
console.log(`Done. ${templates.length} commands generated.`);
