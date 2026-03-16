# Development Workflow

## Flow

1. Clarify the active requirement.
2. Confirm the active phase.
3. Select the next task from `dev/task.json`.
4. Implement in the smallest useful slice.
5. Verify with tests, checks, or scripts.
6. Review against requirements and design.
7. Update `dev/progress.txt` and `.planning/STATE.md`.

## Gates

A task is not done until:

- acceptance criteria are satisfied
- a verification step was run
- any new decision is captured in `.planning/STATE.md`
- progress is logged in `dev/progress.txt`

## Branching

Recommended branch patterns:

- `codex/feature/<task-id>-<slug>`
- `codex/fix/<bug-id>-<slug>`
- `codex/docs/<slug>`

## Review Checklist

- Is the change scoped to the task?
- Are docs still accurate?
- Is there a test or verification note?
- Does the change introduce shared-code coupling?
