import type { ProjectTask } from "@xihe-loom-scaffold/types";

export const SCAFFOLD_NAME = "xihe-loom-scaffold";

export function formatTaskLabel(task: Pick<ProjectTask, "id" | "name" | "status">): string {
  return `[${task.id}] ${task.name} (${task.status})`;
}

export function buildWorkspaceSummary(name: string): string {
  return `${SCAFFOLD_NAME}:${name}`;
}
