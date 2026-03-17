import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function readPrompt() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      resolve(input.trim() || process.argv.slice(2).join(" ").trim());
    });
  });
}

function loadState(statePath) {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {
      clarificationCalls: 0,
      clarificationFailures: 0,
      planCalls: 0,
      revisionCalls: 0
    };
  }
}

function saveState(statePath, state) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function createPlan() {
  return {
    projectName: "office-supplies-ai",
    scope: "@office-supplies-ai",
    description: "AI-assisted office supplies inventory and approval system",
    positioning: "Photo-first office supplies stock workflows with AI-assisted recognition and approvals.",
    currentAssumption: "Admins and employees use mobile photo capture for inbound and outbound stock movements.",
    targetUsers: [
      "office administrators",
      "employees requesting or receiving office supplies"
    ],
    desiredOutcome: "Reduce manual stock handling while keeping an admin approval gate for every important movement.",
    requirements: {
      inScope: [
        "Admin photo-based inbound recognition and stock matching",
        "Create a new stock item when AI cannot match an inbound product",
        "Employee photo-based outbound request flow",
        "Admin approval before outbound stock is finalized",
        "Low inventory threshold alerts"
      ],
      outOfScope: [
        "Supplier purchasing workflows",
        "Multi-warehouse routing",
        "Finance reconciliation"
      ],
      notes: [
        "AI should prefill product type, brand, image, and quantity for new stock entries.",
        "Outbound recognition should estimate quantity from the captured photo before admin approval."
      ]
    },
    roadmap: {
      milestoneName: "Milestone 1: Photo-based stock movements",
      milestoneGoal: "Ship the MVP inbound, outbound approval, and low-stock loop for office supplies.",
      phases: [
        {
          name: "Phase 1: Foundation",
          items: [
            "Confirm the web, API, and persistence stack.",
            "Model products, stock records, stock movements, approvals, and alert thresholds."
          ]
        },
        {
          name: "Phase 2: Recognition workflows",
          items: [
            "Implement inbound image recognition and stock matching.",
            "Implement outbound image submission and admin approval."
          ]
        },
        {
          name: "Phase 3: Alerts and verification",
          items: [
            "Add low-stock alerting.",
            "Add end-to-end checks for the inbound and outbound flows."
          ]
        }
      ]
    },
    state: {
      currentStatus: "Kickoff completed and MVP implementation can begin.",
      activeFocus: "Bootstrap the product foundation and the stock movement workflows.",
      nextStep: "Start by bootstrapping the repo identity, stack decision, and inventory domain model.",
      openDecisions: [
        "Choose the AI vision provider for recognition.",
        "Choose the channel for low-stock alerts."
      ]
    },
    tasks: [
      {
        id: "T001",
        phase: "Phase 1: Foundation",
        type: "planning",
        name: "Bootstrap the office supplies AI workspace",
        description: "Finalize the stack and define the inventory, movement, and approval domain model.",
        priority: "P0",
        status: "todo",
        assignee: "owner",
        depends_on: [],
        acceptance_criteria: [
          "Project identity is updated for office-supplies-ai.",
          "Core entities for product, inventory, movement, approval, and threshold are defined.",
          "The MVP stack decision is captured in planning files."
        ]
      },
      {
        id: "T002",
        phase: "Phase 2: Recognition workflows",
        type: "backend",
        name: "Implement inbound recognition and stock matching",
        description: "Recognize inbound photos, match existing stock items, and branch to new item creation when needed.",
        priority: "P0",
        status: "todo",
        assignee: "owner",
        depends_on: [
          "T001"
        ],
        acceptance_criteria: [
          "Inbound recognition returns predicted type, name, brand, image, and quantity.",
          "Existing stock matches increase quantity after admin confirmation.",
          "Unmatched products create a draft stock item with AI-prefilled fields."
        ]
      },
      {
        id: "T003",
        phase: "Phase 2: Recognition workflows",
        type: "frontend",
        name: "Implement outbound photo request and approval flow",
        description: "Let employees capture outbound photos and submit a request for admin approval.",
        priority: "P0",
        status: "todo",
        assignee: "owner",
        depends_on: [
          "T001"
        ],
        acceptance_criteria: [
          "Employees can upload or capture an image for outbound stock.",
          "AI estimates product and quantity for the outbound request.",
          "Admins can approve or reject the outbound movement."
        ]
      },
      {
        id: "T004",
        phase: "Phase 3: Alerts and verification",
        type: "testing",
        name: "Add low-stock alerts and flow verification",
        description: "Alert when inventory drops below threshold and verify the inbound/outbound flows end to end.",
        priority: "P1",
        status: "todo",
        assignee: "owner",
        depends_on: [
          "T002",
          "T003"
        ],
        acceptance_criteria: [
          "Thresholds can be configured per product.",
          "Low inventory produces an alert event.",
          "The main inbound and outbound flows are covered by end-to-end checks."
        ]
      }
    ],
    progressEntry: "Kickoff completed for office-supplies-ai. Generated the first MVP plan and task queue."
  };
}

const statePath = path.join(process.cwd(), "test-results", "fake-ai-runner-state.json");
const state = loadState(statePath);
const prompt = await readPrompt();

if (!prompt) {
  console.error("No prompt received by fake AI runner.");
  process.exit(1);
}

if (prompt.includes("product intake architect")) {
  state.clarificationCalls += 1;

  if (state.clarificationFailures < 1) {
    state.clarificationFailures += 1;
    saveState(statePath, state);
    console.error("You've hit your limit · resets 10pm (Asia/Shanghai)");
    process.exit(1);
  }

  saveState(statePath, state);
  console.log(
    JSON.stringify({
      assistant_message: "I can start planning once I confirm the MVP workflow and technical direction.",
      suggested_project_name: "office-supplies-ai",
      suggested_scope: "@office-supplies-ai",
      questions: [
        "Who are the primary users in the MVP besides the administrator?",
        "What exact inbound and outbound steps must be approved by an administrator?",
        "Do you want the MVP to stay as a web plus API monorepo scaffold?"
      ]
    })
  );
  process.exit(0);
}

if (prompt.includes("converting a project intake conversation")) {
  state.planCalls += 1;
  saveState(statePath, state);
  console.log(JSON.stringify(createPlan()));
  process.exit(0);
}

if (prompt.includes("revising a project plan")) {
  state.revisionCalls += 1;
  saveState(statePath, state);
  console.log(JSON.stringify(createPlan()));
  process.exit(0);
}

console.error("Fake AI runner received an unrecognized prompt.");
process.exit(1);
