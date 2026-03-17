# Development Workflow

## Flow

1. Read AGENTS.md for role division and rules.
2. Clarify the active requirement from `.planning/REQUIREMENTS.md`.
3. Confirm the active phase from `.planning/ROADMAP.md`.
4. Select the next task from `dev/task.json` (highest priority, dependencies satisfied).
5. Read relevant docs (PRD, tech spec) before implementing.
6. Plan the approach — break into subtasks if parallelizable.
7. Dispatch Sonnet sub-Agents with worktree isolation (see AGENTS.md).
8. Review each Agent's output against acceptance criteria.
9. Merge, verify (build + lint + test), then record progress.

## Quality Gates

A task is NOT done until:

- acceptance criteria are satisfied
- a verification step was run (build, lint, or test)
- Opus has reviewed the diff (for non-trivial changes)
- any new decision is captured in `.planning/STATE.md`
- progress is logged in `dev/progress.txt`
- all changes are in a single commit with conventional format

## Parallel Execution

When multiple tasks are ready or a task decomposes into independent pieces:

1. Opus analyzes and creates sub-Agent prompts
2. Each Sonnet Agent runs in `isolation: 'worktree'`
3. After completion, Opus reviews each branch
4. Merge branches sequentially, resolve conflicts
5. Run verification on the merged result

## Context Management

- Each autopilot round preferably starts a **new session** (fresh context, lower cost)
- Resume sessions only when mid-task continuity is essential
- Long-running sessions degrade in accuracy — prefer fresh rounds

## Branching

Recommended branch patterns:

- `feat/<task-id>-<slug>`
- `fix/<bug-id>-<slug>`
- `docs/<slug>`

## Review Checklist

- Is the change scoped to the task?
- Are docs still accurate?
- Is there a test or verification note?
- Does the change introduce shared-code coupling?
- See `.ai/recipes/review.md` for the full checklist.
