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
  assignee: string;
  depends_on: string[];
  acceptance_criteria: string[];
  steps?: string[];
}

export interface PlanningConfig {
  mode: "interactive" | "yolo";
  granularity: "coarse" | "standard" | "fine";
  workflow: {
    research: boolean;
    plan_check: boolean;
    verifier: boolean;
    auto_advance: boolean;
    nyquist_validation: boolean;
  };
  gates: Record<string, boolean>;
  safety: Record<string, boolean>;
}
