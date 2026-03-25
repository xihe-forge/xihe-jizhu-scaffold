import { rmSync } from "node:fs";
import {
  configureAutopilotWithReadline,
  loadAutopilotConfig,
  probeRunner,
  renderRunnerSummary,
  saveAutopilotConfig
} from "./lib/autopilot-runner.mjs";
import { runTextPrompt } from "./lib/ai-runner.mjs";
import {
  appendProgressEntry,
  initializeProjectIdentity,
  normalizeProjectPlan,
  writeProjectPlan
} from "./lib/project-setup.mjs";
import {
  ensureDir,
  formatDuration,
  pathExists,
  parseQuotaResetWaitSeconds,
  promptChoice,
  promptNumber,
  promptText,
  promptYesNo,
  readJson,
  runCommand,
  sleep,
  withReadline,
  writeJson,
  writeText
} from "./lib/utils.mjs";

const args = process.argv.slice(2);
const INTAKE_STATE_PATH = ".intake/state.json";

function getArg(name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function loadScriptedInput() {
  const file = getArg("scripted-input");
  if (!file) {
    return null;
  }

  const scripted = readJson(file, null);
  if (!scripted) {
    throw new Error(`Unable to read scripted input file: ${file}`);
  }

  return scripted;
}

function createEmptyIntakeState() {
  return {
    version: 1,
    status: "new",
    seed: null,
    clarification: null,
    plan: null,
    review: {
      approved: null,
      correction: "",
      revised: false
    },
    filesWritten: false,
    nextAction: {
      shouldVerify: null,
      shouldStartWork: null,
      verificationCompleted: false,
      autopilotStarted: false
    },
    retry: null,
    updatedAt: new Date().toISOString()
  };
}

function normalizeIntakeState(rawState = null) {
  const base = createEmptyIntakeState();
  if (!rawState || typeof rawState !== "object") {
    return base;
  }

  return {
    ...base,
    ...rawState,
    review: {
      ...base.review,
      ...(rawState.review ?? {})
    },
    nextAction: {
      ...base.nextAction,
      ...(rawState.nextAction ?? {})
    },
    clarification: rawState.clarification
      ? {
          assistantMessage: "",
          suggestedProjectName: "",
          suggestedScope: "",
          questions: [],
          answers: [],
          ...rawState.clarification
        }
      : null
  };
}

function loadIntakeState() {
  ensureDir(".intake");
  return normalizeIntakeState(readJson(INTAKE_STATE_PATH, null));
}

function saveIntakeState(nextState) {
  ensureDir(".intake");
  const normalized = normalizeIntakeState({
    ...nextState,
    updatedAt: new Date().toISOString()
  });
  writeJson(INTAKE_STATE_PATH, normalized);
  return normalized;
}

function clearIntakeState() {
  if (pathExists(INTAKE_STATE_PATH)) {
    rmSync(INTAKE_STATE_PATH, { force: true });
  }
}

function mergeIntakeState(state, patch) {
  return normalizeIntakeState({
    ...state,
    ...patch,
    review: patch.review ? { ...state.review, ...patch.review } : state.review,
    nextAction: patch.nextAction ? { ...state.nextAction, ...patch.nextAction } : state.nextAction,
    clarification: patch.clarification
      ? {
          ...(state.clarification ?? {
            assistantMessage: "",
            suggestedProjectName: "",
            suggestedScope: "",
            questions: [],
            answers: []
          }),
          ...patch.clarification
        }
      : state.clarification
  });
}

function hasSavedIntakeState(state) {
  return !!state && (
    !!state.seed ||
    !!state.clarification ||
    !!state.plan ||
    !!state.filesWritten ||
    !!state.retry
  );
}

function describeIntakeProgress(state) {
  if (!state.seed) {
    return "before collecting the project brief";
  }

  if (!state.clarification?.questions?.length) {
    return "before generating clarification questions";
  }

  const answerCount = Array.isArray(state.clarification.answers)
    ? state.clarification.answers.filter((answer) => String(answer ?? "").trim()).length
    : 0;

  if (answerCount < state.clarification.questions.length) {
    return `while answering clarification question ${answerCount + 1} of ${state.clarification.questions.length}`;
  }

  if (!state.plan) {
    return "before generating the project plan";
  }

  if (!state.filesWritten) {
    return "before writing planning files into the repository";
  }

  if (state.nextAction.shouldVerify === null || state.nextAction.shouldStartWork === null) {
    return "before confirming the final next steps";
  }

  if (state.nextAction.shouldVerify && !state.nextAction.verificationCompleted) {
    return "during repository verification";
  }

  return "near the end of kickoff";
}

function detectFailureCategory(text) {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    normalized.includes("rate limit") ||
    normalized.includes("quota") ||
    normalized.includes("usage limit") ||
    normalized.includes("hit your limit") ||
    normalized.includes("hit the limit") ||
    normalized.includes("credit balance") ||
    normalized.includes("429") ||
    normalized.includes("too many requests")
  ) {
    return "quota";
  }

  return "runner";
}

function getIntakeRetryConfig(scriptedInput) {
  const hasCustomWait =
    getArg("retry-wait-seconds") !== undefined ||
    scriptedInput?.retryWaitSeconds !== undefined;
  return {
    maxRetries: Number(getArg("max-intake-retries") ?? scriptedInput?.maxIntakeRetries ?? 3),
    retryWaitSeconds: Number(getArg("retry-wait-seconds") ?? scriptedInput?.retryWaitSeconds ?? 15),
    hasCustomWait
  };
}

async function waitUntilRetryWindow(retryState) {
  if (!retryState?.nextRetryAt) {
    return;
  }

  const waitMs = new Date(retryState.nextRetryAt).getTime() - Date.now();
  if (waitMs <= 0) {
    return;
  }

  console.log(`[resume] Waiting ${formatDuration(waitMs / 1000)} before retrying ${retryState.stageLabel}.`);
  await sleep(waitMs);
}

async function runPromptWithRetry({
  config,
  model,
  prompt,
  stageLabel,
  pendingStage,
  scriptedInput,
  intakeStateStore
}) {
  const retryConfig = getIntakeRetryConfig(scriptedInput);
  const maxQuotaRetries = Number(getArg("max-quota-retries") ?? scriptedInput?.maxQuotaRetries ?? 5);
  let lastResult = null;
  let runnerFailureCount = 0;
  let quotaFailureCount = 0;
  let totalAttempts = 0;
  const savedRetry = intakeStateStore.get().retry;
  if (savedRetry?.pendingStage === pendingStage) {
    await waitUntilRetryWindow(savedRetry);
  }

  while (true) {
    totalAttempts += 1;
    intakeStateStore.patch({
      status: `running_${pendingStage}`,
      retry: null
    });

    const result = await runTextPrompt({ config, model, prompt });
    if (result.exitCode === 0) {
      intakeStateStore.patch({
        status: `completed_${pendingStage}`,
        retry: null
      });
      return result;
    }

    lastResult = result;
    const detail = [result.stderr, result.error, result.stdout].filter(Boolean).join("\n").trim();
    const failureCategory = detectFailureCategory(detail);
    const isQuotaFailure = failureCategory === "quota";
    const quotaResetWaitSeconds =
      isQuotaFailure && !retryConfig.hasCustomWait
        ? parseQuotaResetWaitSeconds(detail)
        : null;
    const waitSeconds = quotaResetWaitSeconds ?? retryConfig.retryWaitSeconds;
    const nextRetryAt = new Date(Date.now() + waitSeconds * 1000).toISOString();
    const nextRunnerFailureCount = isQuotaFailure ? runnerFailureCount : runnerFailureCount + 1;
    if (isQuotaFailure) {
      quotaFailureCount += 1;
    }

    intakeStateStore.patch({
      status: isQuotaFailure ? "waiting_quota" : "waiting_retry",
      retry: {
        pendingStage,
        stageLabel,
        attempt: totalAttempts,
        failureCount: nextRunnerFailureCount,
        failureCategory,
        failureDetail: detail,
        nextRetryAt
      }
    });

    if (!isQuotaFailure && nextRunnerFailureCount >= retryConfig.maxRetries) {
      runnerFailureCount = nextRunnerFailureCount;
      break;
    }

    if (isQuotaFailure && quotaFailureCount >= maxQuotaRetries) {
      runnerFailureCount = nextRunnerFailureCount;
      break;
    }

    console.log("");
    console.log(
      `[retry] ${stageLabel} failed on attempt ${totalAttempts}. ` +
        `${isQuotaFailure ? `Quota or rate limit detected (${quotaFailureCount}/${maxQuotaRetries} quota retries)` : "AI runner returned an error"}. ` +
        `Waiting ${formatDuration(waitSeconds)} before retrying...`
    );
    if (isQuotaFailure) {
      console.log(
        `[retry] Quota waits do not consume the ${retryConfig.maxRetries} non-quota retry slots for ${stageLabel}.`
      );
    }
    if (detail) {
      console.log(`[retry] detail: ${detail.split(/\r?\n/u)[0]}`);
    }
    runnerFailureCount = nextRunnerFailureCount;
    await sleep(waitSeconds * 1000);
  }

  const finalDetail = [lastResult?.stderr, lastResult?.error, lastResult?.stdout].filter(Boolean).join("\n").trim();
  const reason = quotaFailureCount >= maxQuotaRetries
    ? `${maxQuotaRetries} consecutive quota/rate-limit failures`
    : `${retryConfig.maxRetries} non-quota attempts`;
  throw new Error(
    `${stageLabel} failed after ${reason}.` +
      (finalDetail ? `\n${finalDetail}` : "")
  );
}

function getScriptedClarificationAnswer(scriptedInput, index) {
  const answers = Array.isArray(scriptedInput?.clarificationAnswers)
    ? scriptedInput.clarificationAnswers
    : [];
  return answers[index];
}

function logScriptedAnswer(label, value) {
  const rendered = typeof value === "boolean" ? (value ? "yes" : "no") : String(value ?? "");
  console.log(`${label}: ${rendered} [scripted]`);
}

async function promptTextValue({ rl, scriptedInput, key, label, defaultValue = "" }) {
  if (scriptedInput && scriptedInput[key] !== undefined) {
    const value = String(scriptedInput[key] ?? defaultValue);
    logScriptedAnswer(label, value);
    return value || defaultValue;
  }

  return promptText(rl, label, defaultValue);
}

async function promptYesNoValue({ rl, scriptedInput, key, label, defaultValue = true }) {
  if (scriptedInput && scriptedInput[key] !== undefined) {
    const value = Boolean(scriptedInput[key]);
    logScriptedAnswer(label, value);
    return value;
  }

  return promptYesNo(rl, label, defaultValue);
}

function extractJsonObject(text) {
  if (text == null) {
    throw new Error("AI did not return any output (stdout was null/undefined).");
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`AI did not return a JSON object.\n\nRaw output:\n${text}`);
  }

  return JSON.parse(text.slice(start, end + 1));
}

function buildClarificationPrompt({ projectBrief, constraints }) {
  return [
    "You are the product intake architect for a new software project.",
    "Your job is to help a user clarify a project so autonomous AI can work on it 24/7.",
    "Read the seed idea and return only valid JSON.",
    "Ask at most 3 sharp clarification questions that unblock planning and execution.",
    "Focus on product goal, target user, MVP boundary, and technical constraints.",
    "",
    "Return this JSON shape exactly:",
    '{',
    '  "assistant_message": "short encouraging note",',
    '  "suggested_project_name": "kebab-case name",',
    '  "suggested_scope": "@scope",',
    '  "questions": ["question 1", "question 2", "question 3"]',
    '}',
    "",
    "Project seed:",
    projectBrief,
    "",
    "Known constraints:",
    constraints || "none yet"
  ].join("\n");
}

function buildPlanPrompt({ projectBrief, constraints, clarification }) {
  return [
    "You are converting a project intake conversation into a buildable project plan.",
    "Return only valid JSON. No markdown. No code fences.",
    "Keep the scope realistic for an MVP that autonomous AI can start implementing immediately.",
    "Generate 4 to 7 small, dependency-aware tasks.",
    "",
    "Return this JSON shape exactly:",
    '{',
    '  "projectName": "kebab-case",',
    '  "scope": "@scope",',
    '  "description": "short repo description",',
    '  "positioning": "one-line positioning",',
    '  "currentAssumption": "current assumption",',
    '  "targetUsers": ["user segment"],',
    '  "desiredOutcome": "desired outcome",',
    '  "requirements": {',
    '    "inScope": ["item"],',
    '    "outOfScope": ["item"],',
    '    "notes": ["item"]',
    "  },",
    '  "roadmap": {',
    '    "milestoneName": "Milestone 1: ...",',
    '    "milestoneGoal": "goal",',
    '    "phases": [',
    '      { "name": "Phase 1", "items": ["item"] }',
    "    ]",
    "  },",
    '  "state": {',
    '    "currentStatus": "status",',
    '    "activeFocus": "focus",',
    '    "nextStep": "next step",',
    '    "openDecisions": ["item"]',
    "  },",
    '  "tasks": [',
    '    {',
    '      "id": "T001",',
    '      "phase": "Phase 1: Name",',
    '      "type": "planning|research|implementation|testing|review|docs",',
    '      "name": "task name",',
    '      "description": "task description",',
    '      "priority": "P0|P1|P2",',
    '      "status": "todo",',
    '      "assignee": "owner",',
    '      "depends_on": ["T001"],',
    '      "acceptance_criteria": ["item"]',
    "    }",
    "  ],",
    '  "progressEntry": "first progress log entry"',
    '}',
    "",
    "Project seed:",
    projectBrief,
    "",
    "Constraints:",
    constraints || "none yet",
    "",
    "Clarification transcript:",
    clarification
  ].join("\n");
}

function buildRevisionPrompt({ currentPlanJson, correction }) {
  return [
    "You are revising a project plan based on user feedback.",
    "Return only valid JSON using the same schema as the input plan.",
    "Preserve fields that do not need to change.",
    "",
    "Current plan JSON:",
    currentPlanJson,
    "",
    "User correction:",
    correction
  ].join("\n");
}

function renderPlanSummary(plan) {
  return [
    "",
    "Project plan ready",
    "==================",
    `Name: ${plan.projectName}`,
    `Scope: ${plan.scope}`,
    `Positioning: ${plan.positioning}`,
    `Milestone: ${plan.roadmap.milestoneName}`,
    `Tasks: ${plan.tasks.length}`,
    `Next step: ${plan.state.nextStep}`,
    ""
  ].join("\n");
}

function writeIntakeTranscript({ projectBrief, constraints, questions, answers, plan }) {
  ensureDir("docs/intake");
  const content = [
    "# Project Intake",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Seed Idea",
    "",
    projectBrief,
    "",
    "## Constraints",
    "",
    constraints || "none yet",
    "",
    "## Clarification",
    "",
    ...questions.map((question, index) => [`### Q${index + 1}`, "", question, "", `Answer: ${answers[index] || ""}`, ""].join("\n")),
    "## Result Summary",
    "",
    `- Project: ${plan.projectName}`,
    `- Positioning: ${plan.positioning}`,
    `- Milestone: ${plan.roadmap.milestoneName}`,
    `- Tasks generated: ${plan.tasks.length}`
  ].join("\n");

  writeText("docs/intake/PROJECT-INTAKE.md", content);
}

function createIntakeStateStore(initialState) {
  let currentState = normalizeIntakeState(initialState);

  return {
    get() {
      return currentState;
    },
    patch(patch) {
      currentState = saveIntakeState(mergeIntakeState(currentState, patch));
      return currentState;
    },
    replace(nextState) {
      currentState = saveIntakeState(nextState);
      return currentState;
    },
    clear() {
      clearIntakeState();
      currentState = createEmptyIntakeState();
      return currentState;
    }
  };
}

async function runInterview(rl, config, scriptedInput, intakeStateStore) {
  const planningModel = config.models.planning;
  console.log("");
  console.log("Project Intake");
  console.log("==============");
  console.log("");
  let state = intakeStateStore.get();

  if (!state.seed) {
    const seed = {
      projectBrief: await promptTextValue({
        rl,
        scriptedInput,
        key: "projectBrief",
        label: "Describe what you want to build",
        defaultValue: "AI workflow product for a specific business domain"
      }),
      constraints: await promptTextValue({
        rl,
        scriptedInput,
        key: "constraints",
        label: "Any hard constraints, preferred stack, or must-have capabilities",
        defaultValue: ""
      })
    };

    state = intakeStateStore.patch({
      status: "seed_collected",
      seed,
      retry: null
    });
  } else {
    console.log(`[resume] Project brief already captured. Resuming ${describeIntakeProgress(state)}.`);
  }

  const seed = state.seed;

  if (!state.clarification?.questions?.length) {
    console.log("");
    console.log("AI is preparing the right clarification questions...");
    const clarificationResponse = await runPromptWithRetry({
      config,
      model: planningModel,
      prompt: buildClarificationPrompt(seed),
      stageLabel: "AI clarification step",
      pendingStage: "clarification",
      scriptedInput,
      intakeStateStore
    });

    const clarificationPlan = extractJsonObject(clarificationResponse.stdout);
    state = intakeStateStore.patch({
      status: "clarification_ready",
      clarification: {
        assistantMessage: clarificationPlan.assistant_message || "",
        suggestedProjectName: clarificationPlan.suggested_project_name || "",
        suggestedScope: clarificationPlan.suggested_scope || "",
        questions: Array.isArray(clarificationPlan.questions) ? clarificationPlan.questions.slice(0, 3) : [],
        answers: []
      },
      retry: null
    });
  }

  const clarification = state.clarification;
  const questions = clarification.questions ?? [];
  const answers = Array.isArray(clarification.answers) ? [...clarification.answers] : [];

  if (answers.length < questions.length) {
    console.log("");
    console.log(clarification.assistantMessage || "I need a few details before I can start planning.");
    console.log("");
  }

  for (let index = answers.length; index < questions.length; index += 1) {
    const scriptedAnswer = getScriptedClarificationAnswer(scriptedInput, index);
    const answer = scriptedAnswer !== undefined
      ? (logScriptedAnswer(questions[index], scriptedAnswer), String(scriptedAnswer))
      : await promptText(rl, questions[index], "");
    answers.push(answer);
    state = intakeStateStore.patch({
      status: "answers_collecting",
      clarification: {
        answers: [...answers]
      }
    });
  }

  state = intakeStateStore.patch({
    status: "answers_collected",
    clarification: {
      answers: [...answers]
    },
    retry: null
  });

  let plan = state.plan ? normalizeProjectPlan(state.plan) : null;

  if (!plan) {
    const clarificationTranscript = questions
      .map((question, index) => `Q${index + 1}: ${question}\nA${index + 1}: ${answers[index] || ""}`)
      .join("\n\n");

    console.log("");
    console.log("AI is turning the conversation into a concrete project plan...");
    const planResponse = await runPromptWithRetry({
      config,
      model: planningModel,
      prompt: buildPlanPrompt({
        projectBrief: seed.projectBrief,
        constraints: seed.constraints,
        clarification: clarificationTranscript
      }),
      stageLabel: "AI planning step",
      pendingStage: "planning",
      scriptedInput,
      intakeStateStore
    });

    plan = normalizeProjectPlan(extractJsonObject(planResponse.stdout));
    if (
      clarification.suggestedProjectName &&
      (!plan.projectName || plan.projectName === "my-new-project" || plan.projectName === "xihe-loom-scaffold")
    ) {
      plan.projectName = clarification.suggestedProjectName;
    }
    if ((!plan.scope || plan.scope === `@${plan.projectName}`) && clarification.suggestedScope) {
      plan.scope = clarification.suggestedScope;
    }

    state = intakeStateStore.patch({
      status: "plan_ready",
      plan,
      review: {
        approved: null,
        correction: "",
        revised: false
      },
      retry: null
    });
  }

  plan = normalizeProjectPlan(intakeStateStore.get().plan);
  console.log(renderPlanSummary(plan));

  if (state.review.approved === null) {
    const approved = await promptYesNoValue({
      rl,
      scriptedInput,
      key: "approvePlan",
      label: "Write this plan into the repository",
      defaultValue: true
    });

    if (approved) {
      state = intakeStateStore.patch({
        review: {
          approved: true,
          correction: "",
          revised: state.review.revised
        }
      });
    } else {
      const correction = await promptTextValue({
        rl,
        scriptedInput,
        key: "planCorrection",
        label: "What should be corrected",
        defaultValue: ""
      });
      state = intakeStateStore.patch({
        review: {
          approved: false,
          correction,
          revised: false
        }
      });
    }
  }

  state = intakeStateStore.get();
  if (state.review.approved === false && state.review.correction) {
    if (!state.review.revised) {
      console.log("");
      console.log("AI is revising the plan...");
      const revisedResponse = await runPromptWithRetry({
        config,
        model: planningModel,
        prompt: buildRevisionPrompt({
          currentPlanJson: JSON.stringify(plan, null, 2),
          correction: state.review.correction
        }),
        stageLabel: "AI revision step",
        pendingStage: "revision",
        scriptedInput,
        intakeStateStore
      });

      plan = normalizeProjectPlan(extractJsonObject(revisedResponse.stdout));
      state = intakeStateStore.patch({
        status: "plan_revised",
        plan,
        review: {
          revised: true
        },
        retry: null
      });
    }

    plan = normalizeProjectPlan(intakeStateStore.get().plan);
    console.log(renderPlanSummary(plan));

    const finalApproval = state.review.approved === true
      ? true
      : await promptYesNoValue({
          rl,
          scriptedInput,
          key: "approveRevisedPlan",
          label: "Write the revised plan into the repository",
          defaultValue: true
        });
    if (!finalApproval) {
      throw new Error("Project intake was cancelled before writing files.");
    }

    state = intakeStateStore.patch({
      review: {
        approved: true
      }
    });
  }

  return {
    plan: normalizeProjectPlan(intakeStateStore.get().plan),
    projectBrief: seed.projectBrief,
    constraints: seed.constraints,
    questions,
    answers: intakeStateStore.get().clarification?.answers ?? answers
  };
}

function runVerificationFlow() {
  const commands = [
    ["pnpm", ["install"]],
    ["pnpm", ["health"]],
    ["pnpm", ["autopilot:doctor"]],
    ["pnpm", ["build"]]
  ];

  for (const [command, commandArgs] of commands) {
    const result = runCommand(command, commandArgs);
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

async function main() {
  const scriptedInput = loadScriptedInput();
  const currentConfig = loadAutopilotConfig({ persist: true });
  const intakeStateStore = createIntakeStateStore(loadIntakeState());
  const session = await withReadline(async (rl) => {
    let state = intakeStateStore.get();
    if (hasSavedIntakeState(state)) {
      const shouldResume = scriptedInput?.resumeExistingIntake !== undefined
        ? Boolean(scriptedInput.resumeExistingIntake)
        : await promptYesNo(
            rl,
            `Found unfinished kickoff progress ${describeIntakeProgress(state)}. Resume it`,
            true
          );

      if (!shouldResume) {
        intakeStateStore.clear();
        state = intakeStateStore.get();
        console.log("[resume] Previous kickoff state cleared. Starting fresh.");
      } else {
        console.log(`[resume] Resuming kickoff ${describeIntakeProgress(state)}.`);
        if (state.retry?.failureDetail) {
          console.log(`[resume] Last failure: ${state.retry.failureDetail.split(/\r?\n/u)[0]}`);
        }
      }
      console.log("");
    }

    // --- Configuration Profile Selection ---
    console.log("");
    let userProfile;
    if (scriptedInput?.userProfile !== undefined) {
      userProfile = scriptedInput.userProfile;
      logScriptedAnswer("Configuration mode", userProfile);
    } else {
      const profileIndex = await promptChoice(rl, "Configuration mode:", [
        "One-click (recommended) — smart defaults, just describe your project",
        "Standard — choose review strategy and AI runtime",
        "Advanced — full control over all parameters"
      ], 0);
      userProfile = ["one_click", "standard", "advanced"][profileIndex];
    }

    // --- Project Type Template Selection ---
    console.log("");
    const TEMPLATE_FILES = [
      ".ai/templates/saas.json",
      ".ai/templates/landing-page.json",
      ".ai/templates/api-only.json",
      ".ai/templates/fullstack.json"
    ];
    let selectedTemplate = null;
    let templateIndex;
    if (scriptedInput?.projectTemplate !== undefined) {
      templateIndex = Number(scriptedInput.projectTemplate);
      logScriptedAnswer("Project type", templateIndex);
    } else {
      templateIndex = await promptChoice(rl, "What type of project are you building?", [
        "SaaS Application — full-stack with auth, billing, dashboard",
        "Landing Page / Marketing Site — static or semi-static with i18n",
        "API Service — backend only, REST or GraphQL",
        "Full-Stack Application — frontend + backend with shared types",
        "Custom (no template) — start from scratch"
      ], 4);
    }

    if (templateIndex >= 0 && templateIndex <= 3) {
      selectedTemplate = readJson(TEMPLATE_FILES[templateIndex], null);
      if (selectedTemplate) {
        console.log(`Template applied: ${selectedTemplate.name}`);
        if (Array.isArray(selectedTemplate.suggested_phases) && selectedTemplate.suggested_phases.length > 0) {
          console.log("");
          console.log("Suggested phases for this project type:");
          for (const phase of selectedTemplate.suggested_phases) {
            console.log(`  • ${phase}`);
          }
        }
      }
    }

    // --- Review Strategy (standard & advanced only) ---
    let reviewStrategy = { mode: "auto", custom_rounds: null, zero_bug_threshold: 3 };
    if (userProfile !== "one_click") {
      if (scriptedInput?.reviewStrategy !== undefined) {
        reviewStrategy = scriptedInput.reviewStrategy;
        logScriptedAnswer("Review strategy", reviewStrategy.mode);
      } else {
        console.log("");
        const strategyIndex = await promptChoice(rl, "Review strategy:", [
          "Auto (default) — review rounds scale with project complexity (5-12)",
          "Zero-bug — keep reviewing until bugs < 3",
          "Custom — specify exact number of review rounds"
        ], 0);

        if (strategyIndex === 1) {
          reviewStrategy = { mode: "zero_bug", custom_rounds: null, zero_bug_threshold: 3 };
          if (userProfile === "advanced") {
            const threshold = await promptNumber(rl, "Bug threshold (stop when bugs below this number)", 3);
            reviewStrategy.zero_bug_threshold = threshold;
          }
        } else if (strategyIndex === 2) {
          const rounds = await promptNumber(rl, "Number of review rounds", 8);
          reviewStrategy = { mode: "custom", custom_rounds: rounds, zero_bug_threshold: 3 };
        }
      }
    }

    // --- AI Runtime (standard & advanced only, one_click uses current) ---
    let configured;
    if (userProfile === "one_click") {
      configured = currentConfig;
      console.log("");
      console.log(`AI runtime: ${renderRunnerSummary(configured)} (using default)`);
    } else {
      console.log("");
      console.log(`Current AI runtime: ${renderRunnerSummary(currentConfig)}`);
      const keepCurrent = await promptYesNoValue({
        rl,
        scriptedInput,
        key: "useCurrentRuntime",
        label: "Use this runtime for project intake and 7x24 work",
        defaultValue: true
      });
      configured = keepCurrent
        ? currentConfig
        : await (async () => {
            console.log("");
            return configureAutopilotWithReadline(rl, currentConfig);
          })();
    }

    saveAutopilotConfig(configured);

    const probe = probeRunner(configured);
    if (!probe.passed) {
      throw new Error(
        `AI runtime is not ready: ${renderRunnerSummary(configured)}\n${[
          ...probe.validationIssues,
          probe.probeError
        ]
          .filter(Boolean)
          .join("\n")}`
      );
    }

    console.log("");
    const intake = await runInterview(rl, configured, scriptedInput, intakeStateStore);
    state = intakeStateStore.get();

    if (!state.filesWritten) {
      initializeProjectIdentity({
        projectName: intake.plan.projectName,
        scope: intake.plan.scope,
        description: intake.plan.description,
        positioning: intake.plan.positioning
      });
      writeProjectPlan(intake.plan);
      appendProgressEntry(intake.plan.progressEntry);
      writeIntakeTranscript(intake);
      state = intakeStateStore.patch({
        status: "files_written",
        filesWritten: true
      });
      console.log("");
      console.log("Project files updated from the intake conversation.");
      console.log(`AI runtime: ${renderRunnerSummary(configured)}`);
    } else {
      console.log("");
      console.log("[resume] Planning files were already written in a previous kickoff run.");
    }

    // --- Optional modules (standard & advanced) ---
    let paymentEnabled = false;
    if (userProfile !== "one_click") {
      if (scriptedInput?.enablePayment !== undefined) {
        paymentEnabled = Boolean(scriptedInput.enablePayment);
        logScriptedAnswer("Enable payment/subscription", paymentEnabled);
      } else {
        paymentEnabled = await promptYesNo(rl, "Does this project need payment/subscription (Creem + Wise)", false);
      }

      if (paymentEnabled) {
        console.log("");
        console.log("Payment module enabled. Setup guide: .ai/recipes/payment-integration-guide.md");
        console.log("You will need to:");
        console.log("  1. Register at creem.io and complete KYC");
        console.log("  2. Create products (monthly/yearly plans)");
        console.log("  3. Set up Wise for payouts (non-US developers)");
        console.log("  4. Add API keys to .env when ready");
        console.log("");
        console.log("The scaffold will generate all integration code once you provide the keys.");
      }
    }

    // --- Write review strategy, user profile, and modules to planning config ---
    const planConfig = readJson(".planning/config.json", {});

    // Apply template defaults first (user overrides take precedence below)
    if (selectedTemplate) {
      // Apply review_gates defaults from template
      if (selectedTemplate.review_gates && planConfig.review_gates) {
        for (const [gate, enabled] of Object.entries(selectedTemplate.review_gates)) {
          if (planConfig.review_gates[gate]) {
            planConfig.review_gates[gate] = {
              ...planConfig.review_gates[gate],
              enabled: Boolean(enabled)
            };
          }
        }
      }
      // Apply discipline defaults from template
      if (selectedTemplate.discipline) {
        planConfig.discipline = {
          ...planConfig.discipline,
          ...selectedTemplate.discipline
        };
      }
      // Apply optional_modules defaults from template (payment.enabled only)
      if (selectedTemplate.optional_modules?.payment !== undefined) {
        if (!planConfig.optional_modules) planConfig.optional_modules = {};
        if (!planConfig.optional_modules.payment) planConfig.optional_modules.payment = {};
        planConfig.optional_modules.payment.enabled =
          Boolean(selectedTemplate.optional_modules.payment.enabled);
      }
      // Store selected template name for reference
      planConfig.project_template = selectedTemplate.name;
    }

    planConfig.user_profile = userProfile;
    planConfig.review_strategy = reviewStrategy;
    if (!planConfig.optional_modules) planConfig.optional_modules = {};
    planConfig.optional_modules.payment = {
      ...(planConfig.optional_modules.payment ?? {}),
      enabled: paymentEnabled || planConfig.optional_modules.payment?.enabled || false,
      provider: "creem",
      recipe: ".ai/recipes/payment-integration-guide.md",
      payout_method: "wise"
    };
    writeJson(".planning/config.json", planConfig);

    // --- Merge template starter tasks into dev/task.json ---
    if (selectedTemplate?.starter_tasks?.length > 0) {
      const taskJson = readJson("dev/task.json", null);
      if (taskJson && Array.isArray(taskJson.tasks)) {
        const existingIds = new Set(taskJson.tasks.map((t) => t.id));
        // Find highest existing numeric task ID to avoid collisions
        let maxId = taskJson.tasks.reduce((max, t) => {
          const match = /^T(\d+)$/u.exec(t.id ?? "");
          return match ? Math.max(max, Number(match[1])) : max;
        }, 0);

        const newTasks = [];
        for (const starterTask of selectedTemplate.starter_tasks) {
          maxId += 1;
          const taskId = `T${String(maxId).padStart(3, "0")}`;
          if (!existingIds.has(taskId)) {
            newTasks.push({
              id: taskId,
              phase: selectedTemplate.suggested_phases?.[0] ?? "Phase 1",
              type: starterTask.type ?? "implementation",
              name: starterTask.name,
              description: `Starter task from ${selectedTemplate.name} template.`,
              priority: starterTask.priority ?? "P1",
              status: "todo",
              assignee: "agent",
              depends_on: [],
              acceptance_criteria: []
            });
          }
        }

        if (newTasks.length > 0) {
          taskJson.tasks = [...taskJson.tasks, ...newTasks];
          taskJson.updated_at = new Date().toISOString();
          writeJson("dev/task.json", taskJson);
          console.log(`${newTasks.length} starter task(s) from the ${selectedTemplate.name} template added to dev/task.json.`);
        }
      }
    }

    let shouldVerify = state.nextAction.shouldVerify;
    let shouldStartWork = state.nextAction.shouldStartWork;

    if (userProfile === "one_click") {
      // One-click mode: auto verify + auto start
      if (shouldVerify === null) {
        shouldVerify = true;
        state = intakeStateStore.patch({ nextAction: { shouldVerify } });
      }
      if (shouldStartWork === null) {
        shouldStartWork = true;
        state = intakeStateStore.patch({ nextAction: { shouldStartWork } });
      }
      console.log("");
      console.log("One-click mode: auto-verify and auto-start autopilot.");
    } else {
      if (shouldVerify === null) {
        shouldVerify = await promptYesNoValue({
          rl,
          scriptedInput,
          key: "verifyAfterSetup",
          label: "Run install, health, doctor, and build now",
          defaultValue: true
        });
        state = intakeStateStore.patch({
          nextAction: { shouldVerify }
        });
      }

      if (shouldStartWork === null) {
        shouldStartWork = await promptYesNoValue({
          rl,
          scriptedInput,
          key: "startAutopilot",
          label: "Start 7x24 autopilot after verification",
          defaultValue: false
        });
        state = intakeStateStore.patch({
          nextAction: { shouldStartWork }
        });
      }
    }

    // --- Advanced: additional config options ---
    if (userProfile === "advanced") {
      console.log("");
      console.log("Advanced configuration:");

      const maxConcurrent = await promptNumber(rl, "Max concurrent agents", planConfig.parallelization?.max_concurrent_agents ?? 3);
      const tddDefault = await promptYesNo(rl, "Require TDD (test-driven development)", planConfig.discipline?.tdd_default ?? true);
      const codeReviewRequired = await promptYesNo(rl, "Require code review before merge", planConfig.discipline?.code_review_required ?? true);

      planConfig.parallelization = { ...planConfig.parallelization, max_concurrent_agents: maxConcurrent };
      planConfig.discipline = { ...planConfig.discipline, tdd_default: tddDefault, code_review_required: codeReviewRequired };
      writeJson(".planning/config.json", planConfig);
    }

    return {
      configured,
      shouldVerify,
      shouldStartWork
    };
  });

  let state = intakeStateStore.get();
  if (session.shouldVerify && !state.nextAction.verificationCompleted) {
    runVerificationFlow();
    state = intakeStateStore.patch({
      status: "verification_completed",
      nextAction: {
        verificationCompleted: true
      }
    });
  }

  if (session.shouldStartWork && !state.nextAction.autopilotStarted) {
    intakeStateStore.patch({
      status: "starting_autopilot",
      nextAction: {
        autopilotStarted: true
      }
    });
    const result = runCommand("pnpm", ["work"]);
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
    clearIntakeState();
    return;
  }

  clearIntakeState();
  console.log("Next step: run pnpm work when you want the AI to continue 7x24.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
