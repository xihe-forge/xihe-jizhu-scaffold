import { runCommand, withReadline, promptText, promptYesNo, slugify, readJson } from "./lib/utils.mjs";
import {
  configureAutopilotWithReadline,
  loadAutopilotConfig,
  renderRunnerSummary,
  saveAutopilotConfig
} from "./lib/autopilot-runner.mjs";
import {
  detectCurrentRootName,
  detectCurrentScope,
  initializeProjectIdentity,
  readCurrentPositioning
} from "./lib/project-setup.mjs";

const args = process.argv.slice(2);

function getArg(name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

async function collectInteractiveOptions() {
  const currentRootName = detectCurrentRootName();
  const currentScope = detectCurrentScope();
  const packageJson = readJson("package.json", {});
  const currentDescription = packageJson.description ?? `Project scaffold for ${currentRootName}`;
  const currentPositioning = readCurrentPositioning();
  const currentAutopilotConfig = loadAutopilotConfig({ persist: true });

  return withReadline(async (rl) => {
    console.log("");
    console.log("Project Setup Wizard");
    console.log("====================");
    console.log("");

    const rawName = await promptText(
      rl,
      "Project name",
      currentRootName === "robust-ai-scaffold" ? "my-new-project" : currentRootName
    );
    const projectName = slugify(rawName);
    const scope = await promptText(
      rl,
      "Package scope",
      currentScope === "@robust-ai-scaffold" ? `@${projectName}` : currentScope
    );
    const description = await promptText(rl, "Short description", currentDescription);
    const positioning = await promptText(rl, "One-line positioning", currentPositioning);
    console.log("");
    const autopilotConfig = await configureAutopilotWithReadline(rl, currentAutopilotConfig);
    const shouldVerify = await promptYesNo(rl, "Run install + health + build after setup", true);

    return {
      projectName,
      scope,
      description,
      positioning,
      autopilotConfig,
      shouldVerify
    };
  });
}

function printSummary({ projectName, scope, description, autopilotConfig }) {
  console.log("");
  console.log(`Initialized project: ${projectName}`);
  console.log(`Scope: ${scope}`);
  console.log(`Description: ${description}`);
  if (autopilotConfig) {
    console.log(`AI runtime: ${renderRunnerSummary(autopilotConfig)}`);
  }
}

function runVerificationFlow() {
  console.log("");
  console.log("Running install + health + autopilot doctor + build...");
  console.log("");

  const install = runCommand("pnpm", ["install"]);
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }

  const health = runCommand("pnpm", ["health"]);
  if (health.status !== 0) {
    process.exit(health.status ?? 1);
  }

  const doctor = runCommand("pnpm", ["autopilot:doctor"]);
  if (doctor.status !== 0) {
    process.exit(doctor.status ?? 1);
  }

  const build = runCommand("pnpm", ["build"]);
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

async function main() {
  const argName = getArg("name");

  if (!argName) {
    const interactiveOptions = await collectInteractiveOptions();
    initializeProjectIdentity(interactiveOptions);
    saveAutopilotConfig(interactiveOptions.autopilotConfig);
    printSummary(interactiveOptions);
    if (interactiveOptions.shouldVerify) {
      runVerificationFlow();
    } else {
      console.log("Next step: run pnpm install, pnpm health, pnpm autopilot:doctor, and pnpm build.");
    }
    return;
  }

  const projectName = slugify(argName);
  const scope = getArg("scope") ?? `@${projectName}`;
  const description = getArg("description") ?? `Project scaffold for ${projectName}`;
  const positioning =
    getArg("positioning") ?? `A project initialized from robust-ai-scaffold for ${projectName}.`;

  saveAutopilotConfig(loadAutopilotConfig({ persist: true }));
  initializeProjectIdentity({ projectName, scope, description, positioning });
  printSummary({ projectName, scope, description });
  console.log("Next step: run pnpm install to refresh workspace links, then pnpm health, pnpm autopilot:doctor, and pnpm build.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
