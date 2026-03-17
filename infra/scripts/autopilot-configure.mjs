import { withReadline } from "./lib/utils.mjs";
import {
  configureAutopilotWithReadline,
  loadAutopilotConfig,
  renderRunnerSummary,
  saveAutopilotConfig
} from "./lib/autopilot-runner.mjs";

async function main() {
  const currentConfig = loadAutopilotConfig({ persist: true });
  const nextConfig = await withReadline(async (rl) => {
    console.log("");
    console.log("AI Runtime Wizard");
    console.log("=================");
    console.log("");
    return configureAutopilotWithReadline(rl, currentConfig);
  });

  saveAutopilotConfig(nextConfig);

  console.log("");
  console.log(`Autopilot runtime saved: ${renderRunnerSummary(nextConfig)}`);
  console.log("Next step: run pnpm autopilot:doctor, then pnpm work.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
