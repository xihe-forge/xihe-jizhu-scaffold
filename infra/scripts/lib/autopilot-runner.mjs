import { commandExists, ensureDir, pathExists, promptChoice, promptText, promptYesNo, readJson, runCommand, writeJson } from "./utils.mjs";

const RUNNER_TEMPLATES = {
  claude: {
    displayName: "Claude Code CLI",
    command: "claude",
    supportsResume: true,
    promptTransport: "stdin",
    outputParser: "claude-stream-json",
    doctorArgs: ["--help"],
    permissionMode: "bypassPermissions",
    newSessionArgs: [
      "-p",
      "--permission-mode",
      "{{permissionMode}}",
      "--model",
      "{{model}}",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "{{sessionId}}"
    ],
    resumeSessionArgs: [
      "-p",
      "--permission-mode",
      "{{permissionMode}}",
      "--model",
      "{{model}}",
      "--output-format",
      "stream-json",
      "--verbose",
      "--resume",
      "{{sessionId}}"
    ]
  },
  codex: {
    displayName: "OpenAI Codex CLI",
    command: "codex",
    supportsResume: true,
    promptTransport: "argument",
    outputParser: "codex-jsonl",
    doctorArgs: ["--help"],
    sandboxMode: "workspace-write",
    skipGitRepoCheck: true,
    newSessionArgs: [
      "exec",
      "--json",
      "--full-auto",
      "--skip-git-repo-check",
      "--sandbox",
      "{{sandboxMode}}",
      "--model",
      "{{model}}",
      "{{prompt}}"
    ],
    resumeSessionArgs: [
      "exec",
      "resume",
      "{{sessionId}}",
      "--json",
      "--full-auto",
      "--skip-git-repo-check",
      "--sandbox",
      "{{sandboxMode}}",
      "--model",
      "{{model}}",
      "{{prompt}}"
    ]
  },
  gemini: {
    displayName: "Google Gemini CLI",
    command: "gemini",
    supportsResume: false,
    promptTransport: "stdin",
    outputParser: "plain-text",
    doctorArgs: ["--version"],
    newSessionArgs: [
      "-m",
      "{{model}}"
    ],
    resumeSessionArgs: []
  },
  custom: {
    displayName: "Custom AI command",
    command: "",
    supportsResume: false,
    promptTransport: "stdin",
    outputParser: "plain-text",
    doctorArgs: [],
    newSessionArgs: [],
    resumeSessionArgs: []
  }
};

const MODEL_DEFAULTS = {
  claude: {
    planning: "opus",
    execution: "sonnet"
  },
  codex: {
    planning: "gpt-5.4",
    execution: "gpt-5-codex"
  },
  gemini: {
    planning: "gemini-2.5-pro",
    execution: "gemini-2.5-flash"
  },
  custom: {
    planning: "default-planning-model",
    execution: "default-execution-model"
  }
};

export const DEFAULT_AUTOPILOT_CONFIG = {
  runner: {
    mode: "claude",
    profiles: {
      claude: buildOfficialProfile("claude"),
      codex: buildOfficialProfile("codex"),
      gemini: { ...RUNNER_TEMPLATES.gemini },
      custom: { ...RUNNER_TEMPLATES.custom }
    }
  },
  models: {
    planning: MODEL_DEFAULTS.claude.planning,
    execution: MODEL_DEFAULTS.claude.execution
  },
  loop: {
    waitMinutes: 30,
    maxRetries: 12,
    heartbeatSeconds: 10,
    taskTimeoutSeconds: 1800,
    maxTaskRetries: 2
  },
  behavior: {
    allowTaskGenerationWhenIdle: true,
    updateStateAfterEachRound: true
  },
  scaleThresholds: {
    small: 2,
    medium: 5
  }
};

export const RUNNER_CHOICES = [
  {
    mode: "claude",
    label: "Claude Code CLI",
    description: "Recommended if you already use Claude Code."
  },
  {
    mode: "codex",
    label: "Codex CLI",
    description: "Use codex exec for unattended work rounds."
  },
  {
    mode: "gemini",
    label: "Gemini CLI",
    description: "Use Google Gemini CLI for frontend/design tasks."
  },
  {
    mode: "custom",
    label: "Custom command",
    description: "Advanced mode for another AI CLI."
  }
];

const OUTPUT_PARSER_CHOICES = [
  {
    value: "plain-text",
    label: "Plain text"
  },
  {
    value: "claude-stream-json",
    label: "Claude stream JSON"
  },
  {
    value: "codex-jsonl",
    label: "Codex JSONL"
  }
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep(base, override) {
  if (Array.isArray(base)) {
    return Array.isArray(override) ? clone(override) : clone(base);
  }

  if (!isPlainObject(base)) {
    return override === undefined ? base : override;
  }

  const merged = { ...clone(base) };
  if (!isPlainObject(override)) {
    return merged;
  }

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      merged[key] = clone(value);
      continue;
    }

    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeDeep(merged[key], value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

function quoteArg(token) {
  if (!token) {
    return "\"\"";
  }

  if (/[\s"]/u.test(token)) {
    const escaped = process.platform === "win32"
      ? token.replace(/"/gu, "\"\"")
      : token.replace(/"/gu, "\\\"");
    return `"${escaped}"`;
  }

  return token;
}

function stringifyArgs(args) {
  return (args ?? []).map(quoteArg).join(" ");
}

function tokenizeArgs(input) {
  const tokens = [];
  let current = "";
  let quote = "";
  let escaping = false;

  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    // Backslash only escapes outside single quotes (POSIX behavior)
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = "";
      } else {
        current += character;
      }
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }

    if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function cleanArray(args) {
  return (args ?? []).filter((entry) => typeof entry === "string" && entry.length > 0);
}

function buildOfficialProfile(mode, overrides = {}) {
  const template = RUNNER_TEMPLATES[mode];
  const profile = mergeDeep(template, overrides);

  if (mode === "claude") {
    profile.newSessionArgs = [
      "-p",
      "--permission-mode",
      "{{permissionMode}}",
      "--model",
      "{{model}}",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      "{{sessionId}}"
    ];
    profile.resumeSessionArgs = [
      "-p",
      "--permission-mode",
      "{{permissionMode}}",
      "--model",
      "{{model}}",
      "--output-format",
      "stream-json",
      "--verbose",
      "--resume",
      "{{sessionId}}"
    ];
    return profile;
  }

  profile.newSessionArgs = [
    "exec",
    "--json",
    "--full-auto",
    ...(profile.skipGitRepoCheck === false ? [] : ["--skip-git-repo-check"]),
    "--sandbox",
    "{{sandboxMode}}",
    "--model",
    "{{model}}",
    "{{prompt}}"
  ];
  profile.resumeSessionArgs = [
    "exec",
    "resume",
    "{{sessionId}}",
    "--json",
    "--full-auto",
    ...(profile.skipGitRepoCheck === false ? [] : ["--skip-git-repo-check"]),
    "--sandbox",
    "{{sandboxMode}}",
    "--model",
    "{{model}}",
    "{{prompt}}"
  ];
  return profile;
}

function applyLegacyRunnerOverrides(rawConfig, normalizedConfig) {
  const legacyRunner = rawConfig?.runner ?? {};
  const hasLegacyShape =
    legacyRunner.command !== undefined ||
    legacyRunner.permissionMode !== undefined ||
    legacyRunner.sandboxMode !== undefined ||
    legacyRunner.supportsResume !== undefined ||
    legacyRunner.promptTransport !== undefined ||
    legacyRunner.outputParser !== undefined;

  if (!hasLegacyShape) {
    return normalizedConfig;
  }

  const activeMode = normalizedConfig.runner.mode;
  const legacyOverrides = {};
  for (const key of [
    "command",
    "permissionMode",
    "sandboxMode",
    "supportsResume",
    "promptTransport",
    "outputParser",
    "doctorArgs",
    "newSessionArgs",
    "resumeSessionArgs"
  ]) {
    if (legacyRunner[key] !== undefined) {
      legacyOverrides[key] = legacyRunner[key];
    }
  }

  normalizedConfig.runner.profiles[activeMode] = mergeDeep(
    normalizedConfig.runner.profiles[activeMode],
    legacyOverrides
  );
  return normalizedConfig;
}

export function normalizeAutopilotConfig(rawConfig = {}) {
  const normalized = mergeDeep(DEFAULT_AUTOPILOT_CONFIG, rawConfig);
  const requestedMode = rawConfig?.runner?.mode ?? rawConfig?.runner?.type ?? normalized.runner.mode;
  normalized.runner.mode = RUNNER_TEMPLATES[requestedMode] ? requestedMode : "claude";
  normalized.runner.profiles = mergeDeep(DEFAULT_AUTOPILOT_CONFIG.runner.profiles, rawConfig?.runner?.profiles ?? {});
  applyLegacyRunnerOverrides(rawConfig, normalized);

  normalized.runner.profiles.claude = buildOfficialProfile(
    "claude",
    normalized.runner.profiles.claude
  );
  normalized.runner.profiles.codex = buildOfficialProfile("codex", normalized.runner.profiles.codex);
  normalized.runner.profiles.gemini = mergeDeep(
    RUNNER_TEMPLATES.gemini,
    normalized.runner.profiles.gemini ?? {}
  );
  normalized.runner.profiles.custom = mergeDeep(
    RUNNER_TEMPLATES.custom,
    normalized.runner.profiles.custom
  );
  normalized.runner.profiles.custom.newSessionArgs = cleanArray(
    normalized.runner.profiles.custom.newSessionArgs
  );
  normalized.runner.profiles.custom.resumeSessionArgs = cleanArray(
    normalized.runner.profiles.custom.resumeSessionArgs
  );

  if (!normalized.models?.planning) {
    normalized.models.planning = MODEL_DEFAULTS[normalized.runner.mode].planning;
  }
  if (!normalized.models?.execution) {
    normalized.models.execution = MODEL_DEFAULTS[normalized.runner.mode].execution;
  }

  return normalized;
}

export function loadAutopilotConfig({ persist = false } = {}) {
  ensureDir(".autopilot");
  const fileExists = pathExists(".autopilot/config.json");
  const rawConfig = fileExists ? readJson(".autopilot/config.json", DEFAULT_AUTOPILOT_CONFIG) : DEFAULT_AUTOPILOT_CONFIG;
  const normalized = normalizeAutopilotConfig(rawConfig);

  if (persist || !fileExists) {
    saveAutopilotConfig(normalized);
  }

  return normalized;
}

export function saveAutopilotConfig(config) {
  ensureDir(".autopilot");
  writeJson(".autopilot/config.json", normalizeAutopilotConfig(config));
}

export function getRunnerModeLabel(mode) {
  const choice = RUNNER_CHOICES.find((entry) => entry.mode === mode);
  return choice?.label ?? mode;
}

export function getRunnerModelDefaults(mode) {
  return MODEL_DEFAULTS[mode] ?? MODEL_DEFAULTS.custom;
}

export function resolveRunnerProfile(config) {
  const normalized = normalizeAutopilotConfig(config);
  const mode = normalized.runner.mode;
  return {
    mode,
    ...normalized.runner.profiles[mode]
  };
}

export function renderRunnerSummary(config) {
  const normalized = normalizeAutopilotConfig(config);
  const runner = resolveRunnerProfile(config);
  const detail = runner.mode === "claude"
    ? `permission=${runner.permissionMode}`
    : runner.mode === "codex"
      ? `sandbox=${runner.sandboxMode}`
      : runner.mode === "gemini"
        ? `model=${normalized.models?.execution || normalized.models?.planning || "default"}`
        : `transport=${runner.promptTransport}`;

  return `${getRunnerModeLabel(runner.mode)} (${runner.command || "not configured"}, ${detail})`;
}

export function fillTemplateArgs(args, values) {
  const tokenPattern = /\{\{(.*?)\}\}/gu;
  return cleanArray(
    (args ?? []).map((entry) => {
      const replaced = entry.replace(tokenPattern, (_match, token) => {
        const value = values[token] ?? "";
        return String(value);
      });

      return replaced.trim();
    })
  );
}

export function validateRunnerProfile(runner) {
  const issues = [];

  if (!runner.command) {
    issues.push("Runner command is empty.");
  }

  if (!["stdin", "argument"].includes(runner.promptTransport)) {
    issues.push(`Unsupported prompt transport: ${runner.promptTransport}`);
  }

  if (!["plain-text", "claude-stream-json", "codex-jsonl"].includes(runner.outputParser)) {
    issues.push(`Unsupported output parser: ${runner.outputParser}`);
  }

  if (!Array.isArray(runner.newSessionArgs)) {
    issues.push("newSessionArgs must be an array.");
  }

  if (runner.promptTransport === "argument" && !stringifyArgs(runner.newSessionArgs).includes("{{prompt}}")) {
    issues.push("Prompt transport is argument, but newSessionArgs does not include {{prompt}}.");
  }

  if (runner.supportsResume) {
    if (!Array.isArray(runner.resumeSessionArgs) || runner.resumeSessionArgs.length === 0) {
      issues.push("supportsResume is enabled, but resumeSessionArgs is empty.");
    }
    if (!stringifyArgs(runner.resumeSessionArgs).includes("{{sessionId}}")) {
      issues.push("supportsResume is enabled, but resumeSessionArgs does not include {{sessionId}}.");
    }
  }

  return issues;
}

export function probeRunner(config) {
  const runner = resolveRunnerProfile(config);
  const validationIssues = validateRunnerProfile(runner);
  const commandAvailable = runner.command ? runner.command.length > 0 : false;
  const exists = commandAvailable && commandExists(runner.command);

  if (!commandAvailable) {
    return {
      runner,
      commandFound: false,
      passed: false,
      validationIssues,
      probeError: "Runner command is empty.",
      exitCode: null
    };
  }

  if (!exists) {
    return {
      runner,
      commandFound: false,
      passed: false,
      validationIssues,
      probeError: `Runner command was not found on PATH: ${runner.command}`,
      exitCode: null
    };
  }

  let result = null;
  if (validationIssues.length === 0 && (runner.doctorArgs ?? []).length > 0) {
    result = runCommand(runner.command, runner.doctorArgs, { stdio: "pipe" });
  }

  const errorMessage = result?.error ? String(result.error.message ?? result.error) : "";
  const stderr = result?.stderr ? String(result.stderr).trim() : "";
  const stdout = result?.stdout ? String(result.stdout).trim() : "";
  const probeError = errorMessage || stderr || "";
  const passed =
    validationIssues.length === 0 &&
    (!result || (result.status === 0 && !result.error));

  return {
    runner,
    commandFound: true,
    passed,
    validationIssues,
    probeError,
    stdout,
    exitCode: result?.status ?? null
  };
}

async function configureClaudeProfile(rl, config, modelDefaults) {
  const current = config.runner.profiles.claude;

  config.runner.mode = "claude";
  config.runner.profiles.claude = buildOfficialProfile("claude", {
    ...current,
    command: await promptText(rl, "Claude command", current.command || "claude"),
    permissionMode: await promptText(
      rl,
      "Claude permission mode",
      current.permissionMode || "bypassPermissions"
    )
  });
  config.models.planning = await promptText(
    rl,
    "Planning model",
    modelDefaults.planning
  );
  config.models.execution = await promptText(
    rl,
    "Execution model",
    modelDefaults.execution
  );
  return config;
}

async function configureCodexProfile(rl, config, modelDefaults) {
  const current = config.runner.profiles.codex;

  config.runner.mode = "codex";
  config.runner.profiles.codex = buildOfficialProfile("codex", {
    ...current,
    command: await promptText(rl, "Codex command", current.command || "codex"),
    sandboxMode: await promptText(
      rl,
      "Codex sandbox mode",
      current.sandboxMode || "workspace-write"
    )
  });
  config.models.planning = await promptText(
    rl,
    "Planning model",
    modelDefaults.planning
  );
  config.models.execution = await promptText(
    rl,
    "Execution model",
    modelDefaults.execution
  );
  return config;
}

async function configureGeminiProfile(rl, config, modelDefaults) {
  const current = config.runner.profiles.gemini;

  config.runner.mode = "gemini";
  current.command = await promptText(rl, "Gemini command", current.command || "gemini");
  config.runner.profiles.gemini = mergeDeep(RUNNER_TEMPLATES.gemini, current);
  config.models.planning = await promptText(
    rl,
    "Planning model",
    modelDefaults.planning
  );
  config.models.execution = await promptText(
    rl,
    "Execution model",
    modelDefaults.execution
  );
  return config;
}

async function configureCustomProfile(rl, config, modelDefaults) {
  const current = config.runner.profiles.custom;

  config.runner.mode = "custom";
  current.command = await promptText(rl, "Custom command", current.command || "my-ai-cli");

  const transportIndex = await promptChoice(
    rl,
    "How should autopilot send the prompt?",
    ["Pipe the prompt through stdin", "Pass the prompt as a command argument"],
    current.promptTransport === "argument" ? 1 : 0
  );
  current.promptTransport = transportIndex === 1 ? "argument" : "stdin";

  const parserIndex = await promptChoice(
    rl,
    "Which output parser matches this CLI best?",
    OUTPUT_PARSER_CHOICES.map((choice) => choice.label),
    Math.max(
      0,
      OUTPUT_PARSER_CHOICES.findIndex((choice) => choice.value === current.outputParser)
    )
  );
  current.outputParser = OUTPUT_PARSER_CHOICES[parserIndex]?.value ?? "plain-text";

  current.supportsResume = await promptYesNo(
    rl,
    "Does this CLI support resuming by session ID",
    current.supportsResume ?? false
  );

  const defaultNewArgs = current.promptTransport === "argument"
    ? stringifyArgs(current.newSessionArgs.length > 0 ? current.newSessionArgs : ["run", "--model", "{{model}}", "{{prompt}}"])
    : stringifyArgs(current.newSessionArgs.length > 0 ? current.newSessionArgs : ["run", "--model", "{{model}}"]);
  const newArgsInput = await promptText(rl, "Args for a new run", defaultNewArgs);
  current.newSessionArgs = tokenizeArgs(newArgsInput);

  if (current.supportsResume) {
    const defaultResumeArgs = current.promptTransport === "argument"
      ? stringifyArgs(
          current.resumeSessionArgs.length > 0
            ? current.resumeSessionArgs
            : ["resume", "{{sessionId}}", "--model", "{{model}}", "{{prompt}}"]
        )
      : stringifyArgs(
          current.resumeSessionArgs.length > 0
            ? current.resumeSessionArgs
            : ["resume", "{{sessionId}}", "--model", "{{model}}"]
        );
    const resumeArgsInput = await promptText(rl, "Args for resume", defaultResumeArgs);
    current.resumeSessionArgs = tokenizeArgs(resumeArgsInput);
  } else {
    current.resumeSessionArgs = [];
  }

  const doctorArgsInput = await promptText(
    rl,
    "Args for doctor check",
    stringifyArgs(current.doctorArgs.length > 0 ? current.doctorArgs : ["--help"])
  );
  current.doctorArgs = tokenizeArgs(doctorArgsInput);

  config.runner.profiles.custom = mergeDeep(RUNNER_TEMPLATES.custom, current);
  config.models.planning = await promptText(
    rl,
    "Planning model",
    modelDefaults.planning
  );
  config.models.execution = await promptText(
    rl,
    "Execution model",
    modelDefaults.execution
  );
  return config;
}

export async function configureAutopilotWithReadline(rl, currentConfig = DEFAULT_AUTOPILOT_CONFIG) {
  const config = normalizeAutopilotConfig(currentConfig);
  const previousMode = config.runner.mode;
  const selectedIndex = await promptChoice(
    rl,
    "Which AI runtime should 24/7 autopilot use?",
    RUNNER_CHOICES.map((choice) => `${choice.label} - ${choice.description}`),
    Math.max(
      0,
      RUNNER_CHOICES.findIndex((choice) => choice.mode === config.runner.mode)
    )
  );
  const selectedMode = RUNNER_CHOICES[selectedIndex]?.mode ?? "claude";
  const modeDefaults = getRunnerModelDefaults(selectedMode);
  const modelDefaults = previousMode === selectedMode
    ? {
        planning: config.models.planning || modeDefaults.planning,
        execution: config.models.execution || modeDefaults.execution
      }
    : modeDefaults;

  if (selectedMode === "claude") {
    return configureClaudeProfile(rl, config, modelDefaults);
  }

  if (selectedMode === "codex") {
    return configureCodexProfile(rl, config, modelDefaults);
  }

  if (selectedMode === "gemini") {
    return configureGeminiProfile(rl, config, modelDefaults);
  }

  return configureCustomProfile(rl, config, modelDefaults);
}
