import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(".");
const commandsDir = path.join(root, ".claude", "commands");

// Load command registry
const registryPath = path.join(commandsDir, "command-registry.json");
if (!existsSync(registryPath)) {
  console.error("FAIL: command-registry.json not found at", registryPath);
  process.exit(1);
}
const registry = JSON.parse(readFileSync(registryPath, "utf8"));

// Load skill registry
const skillRegistryPath = path.join(root, ".ai", "skills", "skill-registry.json");
if (!existsSync(skillRegistryPath)) {
  console.error("FAIL: skill-registry.json not found at", skillRegistryPath);
  process.exit(1);
}
const skillRegistry = JSON.parse(readFileSync(skillRegistryPath, "utf8"));

// Build set of valid skill IDs from skill-registry.json
const validSkills = new Set();
for (const [moduleName, moduleData] of Object.entries(skillRegistry.skills)) {
  if (moduleData.skills) {
    for (const skillName of Object.keys(moduleData.skills)) {
      validSkills.add(`${moduleName}/${skillName}`);
    }
  }
}

let errors = 0;

for (const [cmdName, cmdMeta] of Object.entries(registry.commands)) {
  // Check template exists
  const tmplPath = path.join(commandsDir, `${cmdName}.md.tmpl`);
  if (!existsSync(tmplPath)) {
    console.error(`FAIL: template missing for command "${cmdName}": ${tmplPath}`);
    errors++;
  } else {
    console.log(`OK: template exists — ${cmdName}.md.tmpl`);
  }

  // Check skills exist in skill-registry.json
  for (const skillId of cmdMeta.skills || []) {
    if (!validSkills.has(skillId)) {
      console.error(`FAIL: command "${cmdName}" references unknown skill "${skillId}"`);
      errors++;
    } else {
      console.log(`OK: skill "${skillId}" found in skill-registry.json`);
    }
  }

  // Check recipe files exist on disk
  for (const recipe of cmdMeta.recipes || []) {
    const recipePath = path.join(root, ".ai", "recipes", recipe);
    if (!existsSync(recipePath)) {
      console.error(`FAIL: command "${cmdName}" references missing recipe "${recipe}" (expected at ${recipePath})`);
      errors++;
    } else {
      console.log(`OK: recipe "${recipe}" exists on disk`);
    }
  }
}

if (errors > 0) {
  console.error(`\nValidation FAILED with ${errors} error(s).`);
  process.exit(1);
} else {
  console.log(`\nValidation PASSED. All commands, skills, and recipes verified.`);
}
