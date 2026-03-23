import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

const commandsDir = path.resolve(".", ".claude", "commands");
const preamble = readFileSync(path.join(commandsDir, "preamble.md"), "utf8");

const templates = readdirSync(commandsDir).filter(f => f.endsWith(".md.tmpl"));

for (const tmpl of templates) {
  const tmplPath = path.join(commandsDir, tmpl);
  const outPath = path.join(commandsDir, tmpl.replace(".md.tmpl", ".md"));
  let content = readFileSync(tmplPath, "utf8");
  content = content.replace("{{PREAMBLE}}", preamble);
  const header = "<!-- GENERATED FILE — edit the .md.tmpl source, then run: pnpm gen:commands -->\n";
  writeFileSync(outPath, header + content, "utf8");
  console.log(`Generated: ${tmpl.replace(".md.tmpl", ".md")}`);
}
console.log(`Done. ${templates.length} commands generated.`);
