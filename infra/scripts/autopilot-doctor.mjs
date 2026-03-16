import { pathExists } from "./lib/utils.mjs";
import {
  loadAutopilotConfig,
  probeRunner,
  renderRunnerSummary
} from "./lib/autopilot-runner.mjs";

const config = loadAutopilotConfig({ persist: true });
const probe = probeRunner(config);

const checks = [
  ["dev/task.json exists", pathExists("dev/task.json")],
  ["dev/progress.txt exists", pathExists("dev/progress.txt")],
  [".planning/STATE.md exists", pathExists(".planning/STATE.md")],
  [".autopilot/config.json exists", pathExists(".autopilot/config.json")],
  [`Runner command is available (${probe.runner.command || "not configured"})`, probe.commandFound],
  [
    `Runner probe succeeded (${probe.runner.doctorArgs?.join(" ") || "no probe args configured"})`,
    probe.passed
  ],
  [
    "Not running inside Claude Code",
    probe.runner.mode !== "claude" || !process.env.CLAUDECODE
  ]
];

let hasFailure = false;

console.log("");
console.log("Autopilot Doctor");
console.log("================");
console.log(`[INFO] Active runner: ${renderRunnerSummary(config)}`);

for (const [label, passed] of checks) {
  console.log(`${passed ? "[OK]" : "[FAIL]"} ${label}`);
  if (!passed) {
    hasFailure = true;
  }
}

if (probe.validationIssues.length > 0) {
  hasFailure = true;
  for (const issue of probe.validationIssues) {
    console.log(`[FAIL] ${issue}`);
  }
}

if (probe.probeError) {
  console.log(`[INFO] Probe detail: ${probe.probeError}`);
}

if (probe.stdout) {
  console.log(`[INFO] Probe output: ${probe.stdout.split(/\r?\n/u)[0]}`);
}

if (hasFailure) {
  console.log("[INFO] Fix the runtime with pnpm autopilot:configure or edit .autopilot/config.json.");
  process.exit(1);
}
