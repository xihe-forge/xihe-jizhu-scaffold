export type TaskPriority = "P0" | "P1" | "P2";
export type TaskStatus = "todo" | "in_progress" | "done" | "blocked" | "skipped";
export type TaskType =
  | "planning"
  | "research"
  | "implementation"
  | "testing"
  | "review"
  | "docs";

export interface ProjectTask {
  id: string;
  name: string;
  status: TaskStatus;
  priority: TaskPriority;
  type: TaskType;
  description: string;
  assignee: "opus" | "sonnet" | "codex" | "gemini" | (string & {});
  depends_on: string[];
  acceptance_criteria: string[];
  steps?: string[];
}

export interface ReviewGate {
  enabled: boolean;
  blocking: boolean;
  recipe: string;
  tools: string[];
  require_full_prd_coverage?: boolean;
}

export interface ReviewTool {
  path: string;
  description: string;
  skills?: string[];
  scripts?: Record<string, string>;
}

export interface PlanningConfig {
  mode: "interactive" | "one-click" | "standard" | "advanced";
  granularity: "coarse" | "standard" | "fine";
  responsive_breakpoints?: number[];
  workflow: {
    research: boolean;
    plan_check: boolean;
    verifier: boolean;
    auto_advance: boolean;
    nyquist_validation: boolean;
  };
  gates: Record<string, boolean>;
  safety: Record<string, boolean>;
  discipline?: {
    tdd_default: boolean;
    code_review_required: boolean;
    verification_required: boolean;
  };
  review_gates?: Record<string, ReviewGate>;
  optional_modules?: {
    payment?: {
      enabled: boolean;
      provider: string;
      recipe: string;
      payout_method: string;
    };
  };
  user_profile?: string;
  review_strategy?: {
    mode: "auto" | "zero_bug" | "custom";
    custom_rounds: number | null;
    zero_bug_threshold: number;
  };
  final_review?: {
    enabled: boolean;
    max_rounds: number | "auto";
    parallel_reviewers: Record<string, string[]>;
    recipe: string;
    convergence: string;
  };
  review_tools?: Record<string, ReviewTool>;
}
