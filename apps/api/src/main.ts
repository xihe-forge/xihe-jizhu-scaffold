import { SCAFFOLD_NAME, formatTaskLabel } from "@xihe-jizhu-scaffold/shared";
import type { ProjectTask } from "@xihe-jizhu-scaffold/types";

const starterTask: ProjectTask = {
  id: "T000",
  name: "Replace scaffold placeholders",
  status: "todo",
  priority: "P0",
  type: "planning",
  description: "Adapt the scaffold to your backend domain.",
  assignee: "owner",
  depends_on: [],
  acceptance_criteria: [
    "Backend stack chosen",
    "API boundaries identified",
    "First feature path defined"
  ]
};

export const apiScaffoldEntry = {
  scaffold: SCAFFOLD_NAME,
  role: "api",
  nextAction: formatTaskLabel(starterTask),
  note: "Replace this placeholder with your backend bootstrap."
};
