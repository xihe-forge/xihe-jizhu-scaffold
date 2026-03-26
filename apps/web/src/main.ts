import { SCAFFOLD_NAME, formatTaskLabel } from "@xihe-jizhu-scaffold/shared";
import type { ProjectTask } from "@xihe-jizhu-scaffold/types";

const starterTask: ProjectTask = {
  id: "T000",
  name: "Replace scaffold placeholders",
  status: "todo",
  priority: "P0",
  type: "planning",
  description: "Adapt the scaffold to your project domain.",
  assignee: "owner",
  depends_on: [],
  acceptance_criteria: [
    "Project name updated",
    "Stack decisions captured",
    "First milestone defined"
  ]
};

export const webScaffoldEntry = {
  scaffold: SCAFFOLD_NAME,
  role: "web",
  nextAction: formatTaskLabel(starterTask),
  note: "Replace this placeholder with your frontend bootstrap."
};
