import { pathExists, readJson } from "./lib/utils.mjs";
import { loadAutopilotConfig, renderRunnerSummary, resolveRunnerProfile } from "./lib/autopilot-runner.mjs";

const hasStopSignal = pathExists(".autopilot/.stop");
const config = loadAutopilotConfig({ persist: true });
const state = readJson(".autopilot/state.json", null);
const runner = resolveRunnerProfile(config);

console.log("");
console.log("Autopilot Status");
console.log("================");
console.log(`Configured: ${pathExists(".autopilot/config.json") ? "yes" : "no"}`);
console.log(`Runner: ${renderRunnerSummary(config)}`);
console.log(`Prompt transport: ${runner.promptTransport}`);
console.log(`Output parser: ${runner.outputParser}`);
console.log(`Planning model: ${config.models?.planning ?? "unknown"}`);
console.log(`Execution model: ${config.models?.execution ?? "unknown"}`);
console.log(`Stop signal present: ${hasStopSignal ? "yes" : "no"}`);

if (!state) {
  console.log("State: not started yet");
  process.exit(0);
}

console.log(`State: ${state.status ?? "unknown"}`);
console.log(`Round: ${state.round ?? 0}`);
console.log(`Retry count: ${state.retryCount ?? 0}`);
console.log(`Session ID: ${state.sessionId ?? "(none)"}`);
console.log(`Last task: ${state.lastTaskId ?? "(none)"}`);
console.log(`Last exit code: ${state.lastExitCode ?? "(none)"}`);
console.log(`Last failure category: ${state.lastFailureCategory ?? "(none)"}`);
console.log(`Last failure hint: ${state.lastFailureHint ?? "(none)"}`);
console.log(`Updated at: ${state.updatedAt ?? "(unknown)"}`);
