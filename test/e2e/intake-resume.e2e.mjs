import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const repoRoot = process.cwd();
const sandboxRoot = path.join(os.tmpdir(), "xihe-loom-scaffold-intake-resume-e2e");
const projectRoot = path.join(sandboxRoot, "workspace");
const scriptedInputPath = path.join(projectRoot, "test-results", "scripted-intake.json");
const intakeStatePath = path.join(projectRoot, ".intake", "state.json");
const fakeRunnerStatePath = path.join(projectRoot, "test-results", "fake-ai-runner-state.json");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function copyFilter(source) {
  const relativePath = path.relative(repoRoot, source);
  if (!relativePath) {
    return true;
  }

  const segments = relativePath.split(path.sep);
  return !segments.some((segment) => ["node_modules", ".turbo", "test-results"].includes(segment));
}

function createWorkspaceCopy() {
  rmSync(sandboxRoot, { recursive: true, force: true });
  mkdirSync(sandboxRoot, { recursive: true });
  cpSync(repoRoot, projectRoot, {
    recursive: true,
    filter: copyFilter
  });
  rmSync(path.join(projectRoot, ".autopilot", "state.json"), { force: true });
  rmSync(path.join(projectRoot, ".autopilot", ".stop"), { force: true });
  rmSync(path.join(projectRoot, ".autopilot", "logs"), { recursive: true, force: true });
  rmSync(path.join(projectRoot, ".intake", "state.json"), { force: true });
}

function configureFakeRunner() {
  const configPath = path.join(projectRoot, ".autopilot", "config.json");
  const config = readJson(configPath);
  config.runner.mode = "custom";
  config.runner.profiles.custom = {
    displayName: "Fake E2E Runner",
    command: "node",
    supportsResume: false,
    promptTransport: "stdin",
    outputParser: "plain-text",
    doctorArgs: [
      "--version"
    ],
    newSessionArgs: [
      "test/e2e/fake-ai-runner.mjs"
    ],
    resumeSessionArgs: []
  };
  config.models = {
    planning: "fake-planning",
    execution: "fake-execution"
  };
  writeJson(configPath, config);
}

function writeScriptedInput() {
  writeJson(scriptedInputPath, {
    useCurrentRuntime: true,
    resumeExistingIntake: true,
    projectBrief:
      "AI office supplies inventory management. Admins photograph inbound products, AI recognizes product type, product name, quantity, and compares against existing stock. If matched, it increases stock after confirmation. If unmatched, AI prefills a new stock item for admin review. Employees photograph outbound supplies, AI estimates the quantity and sends an outbound request for admin approval. Low inventory should raise alerts.",
    constraints:
      "Keep the scaffold as a web plus API monorepo. The MVP should cover inbound stock, outbound approval, and low inventory alerts.",
    clarificationAnswers: [
      "Primary users are administrators managing stock and employees requesting office supplies.",
      "Inbound stock is only finalized after admin confirmation, and outbound stock must be approved by an administrator before quantities decrease.",
      "Yes. Keep the monorepo scaffold with a web app and an API service."
    ],
    approvePlan: true,
    verifyAfterSetup: false,
    startAutopilot: false
  });
}

function runNodeCommand(args, options = {}) {
  return spawn(process.execPath, args, {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    ...options
  });
}

async function waitFor(condition, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = condition();
    if (result) {
      return result;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

async function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout,
        stderr
      });
    });
  });
}

async function runKickoffWithForcedInterruption() {
  const child = runNodeCommand([
    "infra/scripts/project-intake.mjs",
    "--scripted-input",
    scriptedInputPath,
    "--retry-wait-seconds",
    "30"
  ]);
  const exitPromise = waitForExit(child);

  const savedState = await waitFor(() => {
    if (!existsSync(intakeStatePath)) {
      return null;
    }

    const state = readJson(intakeStatePath);
    if (state.retry?.pendingStage === "clarification") {
      return state;
    }

    return null;
  });

  child.kill();
  const result = await exitPromise;

  return {
    savedState,
    result
  };
}

function runKickoffToCompletion() {
  const result = spawnSync(
    process.execPath,
    [
      "infra/scripts/project-intake.mjs",
      "--scripted-input",
      scriptedInputPath,
      "--retry-wait-seconds",
      "1"
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe"
    }
  );

  return result;
}

function runVerificationSmoke() {
  const health = spawnSync(process.execPath, ["infra/scripts/health-check.mjs"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "pipe"
  });
  assert(health.status === 0, `Health check failed.\n${health.stdout}\n${health.stderr}`);

  const autopilot = spawnSync(
    process.execPath,
    ["infra/scripts/autopilot-start.mjs", "--dry-run", "--once"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe"
    }
  );
  assert(autopilot.status === 0, `Autopilot dry run failed.\n${autopilot.stdout}\n${autopilot.stderr}`);
}

function assertGeneratedFiles() {
  const projectMarkdown = readFileSync(path.join(projectRoot, ".planning", "PROJECT.md"), "utf8");
  const intakeMarkdown = readFileSync(path.join(projectRoot, "docs", "intake", "PROJECT-INTAKE.md"), "utf8");
  const tasks = readJson(path.join(projectRoot, "dev", "task.json"));
  const fakeRunnerState = readJson(fakeRunnerStatePath);

  assert(projectMarkdown.includes("office-supplies-ai"), "PROJECT.md was not updated with the generated project name.");
  assert(intakeMarkdown.includes("office-supplies-ai"), "PROJECT-INTAKE.md was not generated.");
  assert(tasks.project === "office-supplies-ai", "dev/task.json project name is incorrect.");
  assert(Array.isArray(tasks.tasks) && tasks.tasks.length === 4, "Expected 4 generated tasks.");
  assert(!existsSync(intakeStatePath), "Kickoff state was not cleared after completion.");
  assert(fakeRunnerState.clarificationFailures === 1, "Fake runner did not simulate exactly one quota failure.");
  assert(fakeRunnerState.clarificationCalls >= 2, "Kickoff did not retry the clarification stage.");
}

async function main() {
  console.log("Preparing intake resume E2E workspace...");
  createWorkspaceCopy();
  configureFakeRunner();
  writeScriptedInput();

  console.log("Running kickoff and forcing an interruption after a simulated quota failure...");
  const firstRun = await runKickoffWithForcedInterruption();

  assert(firstRun.savedState.seed?.projectBrief, "Seed data was not saved before interruption.");
  assert(firstRun.savedState.retry?.pendingStage === "clarification", "Kickoff did not persist the clarification retry state.");
  assert(firstRun.savedState.retry?.failureCategory === "quota", "The persisted retry state did not classify the failure as quota-related.");

  console.log("Resuming kickoff from saved state...");
  const secondRun = runKickoffToCompletion();
  assert(secondRun.status === 0, `Kickoff resume run failed.\n${secondRun.stdout}\n${secondRun.stderr}`);

  console.log("Checking generated planning files and autopilot handoff...");
  assertGeneratedFiles();
  runVerificationSmoke();

  console.log("intake resume E2E passed");
  console.log(`Workspace: ${projectRoot}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
