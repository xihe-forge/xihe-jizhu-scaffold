import { spawn } from "node:child_process";
import { buildShellCommandLine, getExecutable, requiresCommandShell } from "./utils.mjs";
import { fillTemplateArgs, resolveRunnerProfile } from "./autopilot-runner.mjs";

export async function runTextPrompt({ config, prompt, model }) {
  const runner = resolveRunnerProfile(config);
  const command = getExecutable(runner.command);
  let args;

  if (runner.mode === "claude") {
    args = [
      "-p",
      "--permission-mode",
      runner.permissionMode ?? "bypassPermissions",
      "--model",
      model,
      "--output-format",
      "text"
    ];
  } else if (runner.mode === "codex") {
    args = [
      "exec",
      "--full-auto",
      "--skip-git-repo-check",
      "--sandbox",
      runner.sandboxMode ?? "workspace-write",
      "--model",
      model,
      prompt
    ];
  } else {
    args = fillTemplateArgs(runner.newSessionArgs, {
      prompt,
      model,
      sessionId: "",
      permissionMode: runner.permissionMode ?? "",
      sandboxMode: runner.sandboxMode ?? "",
      cwd: process.cwd()
    });
  }

  const useShellWrapper = requiresCommandShell(command) && (runner.mode === "claude" || runner.promptTransport === "stdin");
  const child = useShellWrapper
    ? spawn(buildShellCommandLine(command, args), {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: true
      })
    : spawn(command, args, {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: requiresCommandShell(command)
      });

  if (runner.mode === "claude" || runner.promptTransport === "stdin") {
    child.stdin.write(prompt);
  }
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  let spawnError = null;

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  child.on("error", (error) => {
    spawnError = error;
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", (code) => {
      resolve(spawnError ? 1 : (code ?? 1));
    });
  });

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    error: spawnError ? String(spawnError.message ?? spawnError) : ""
  };
}
