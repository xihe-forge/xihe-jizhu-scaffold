import { runCommand, withReadline, promptChoice } from "./lib/utils.mjs";

function runAndExitOnFailure(command, args) {
  const result = runCommand(command, args);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main() {
  const choices = [
    "Talk to AI and define the project",
    "Manual setup wizard",
    "Configure AI runtime",
    "Check project status",
    "Start 24/7 AI autopilot",
    "Show autopilot status",
    "Stop autopilot",
    "Exit"
  ];

  const selectedIndex = await withReadline(async (rl) =>
    promptChoice(rl, "\nWhat do you want to do?", choices, 0)
  );

  switch (selectedIndex) {
    case 0:
      runAndExitOnFailure("node", ["infra/scripts/project-intake.mjs"]);
      break;
    case 1:
      runAndExitOnFailure("node", ["infra/scripts/init-project.mjs"]);
      break;
    case 2:
      runAndExitOnFailure("node", ["infra/scripts/autopilot-configure.mjs"]);
      break;
    case 3:
      runAndExitOnFailure("pnpm", ["health"]);
      runAndExitOnFailure("pnpm", ["plan:status"]);
      break;
    case 4:
      runAndExitOnFailure("pnpm", ["autopilot:doctor"]);
      runAndExitOnFailure("node", ["infra/scripts/autopilot-start.mjs"]);
      break;
    case 5:
      runAndExitOnFailure("node", ["infra/scripts/autopilot-status.mjs"]);
      break;
    case 6:
      runAndExitOnFailure("node", ["infra/scripts/autopilot-stop.mjs"]);
      break;
    default:
      console.log("Bye.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
