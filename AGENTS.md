# AGENTS.md

## Repo Rules

This repository treats process artifacts as first-class project assets.

### Sources of truth

1. `.planning/PROJECT.md`: project identity
2. `.planning/REQUIREMENTS.md`: in-scope and out-of-scope behavior
3. `.planning/ROADMAP.md`: milestone and phase sequence
4. `.planning/STATE.md`: current status, decisions, blockers, next step
5. `docs/intake/PROJECT-INTAKE.md`: the original intake conversation and framing
6. `dev/task.json`: execution queue and acceptance criteria
7. `dev/progress.txt`: chronological progress log

### Working order

1. Read `.planning/STATE.md`
2. Read the active phase in `.planning/phases/`
3. Check `dev/task.json`
4. Implement the smallest task that moves the phase forward
5. Update `dev/progress.txt` and state files after meaningful progress

### Delivery rules

- Do not skip planning for non-trivial changes.
- Default to TDD or at least test-before-complete for logic changes.
- Record bugs in `dev/bug_fix/`.
- Record review outcomes in `dev/review/`.
- Keep docs and implementation aligned.
