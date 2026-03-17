import { ensureDir, writeText, writeJson, readJson } from "./lib/utils.mjs";

ensureDir(".autopilot");
writeText(".autopilot/.stop", "stop\n");

const currentState = readJson(".autopilot/state.json", {});
writeJson(".autopilot/state.json", {
  ...currentState,
  status: "stopping_requested",
  updatedAt: new Date().toISOString()
});

console.log("Stop signal written to .autopilot/.stop");
