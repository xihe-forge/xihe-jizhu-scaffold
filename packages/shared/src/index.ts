import type { ProjectTask } from "@robust-ai-scaffold/types";

export const SCAFFOLD_NAME = "robust-ai-scaffold";

export function formatTaskLabel(task: Pick<ProjectTask, "id" | "name" | "status">): string {
  return `[${task.id}] ${task.name} (${task.status})`;
}

export function buildWorkspaceSummary(name: string): string {
  return `${SCAFFOLD_NAME}:${name}`;
}
