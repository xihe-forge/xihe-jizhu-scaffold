# AGENTS.md

## Repo Rules

This repository treats process artifacts as first-class project assets.
AI agents MUST read this file before every round of work.

### Sources of Truth

1. `.planning/PROJECT.md`: project identity and positioning
2. `.planning/REQUIREMENTS.md`: in-scope and out-of-scope behavior
3. `.planning/ROADMAP.md`: milestone and phase sequence
4. `.planning/STATE.md`: current status, decisions, blockers, next step
5. `docs/intake/PROJECT-INTAKE.md`: the original intake conversation and framing
6. `dev/task.json`: execution queue with priorities, dependencies, and acceptance criteria
7. `dev/progress.txt`: chronological progress log

### Working Order

1. Read this file (AGENTS.md)
2. Read `.planning/STATE.md` and `.planning/ROADMAP.md`
3. Read the active phase in `.planning/phases/`
4. Check `dev/task.json` for the next runnable task (highest priority, all dependencies satisfied)
5. Read relevant docs (PRD, tech spec) before implementing
6. Implement the smallest task that moves the phase forward
7. Verify (build, test, lint) before declaring complete
8. Update `dev/task.json`, `dev/progress.txt`, and `.planning/STATE.md`
9. Git commit all changes together

### Role Division: Opus vs Sonnet

The autopilot system uses a two-tier model:

| Role | Model | Responsibilities |
|------|-------|-----------------|
| **Orchestrator** | Opus | Planning, task analysis, review, documentation, merge coordination |
| **Worker** | Sonnet | Implementation, testing, bug fixes, refactoring |

**Rules:**
- The main autopilot process ALWAYS runs as Opus (the orchestrator)
- Opus reads the task, decides how to break it down, then dispatches Sonnet sub-Agents
- Every coding sub-Agent MUST use `model: 'sonnet'` and `isolation: 'worktree'`
- Opus reviews each sub-Agent's output before merging

### Parallel Execution Strategy

When multiple tasks are ready (dependencies satisfied), or a single task can be decomposed:

1. **Analyze**: Opus determines which tasks/subtasks can run in parallel
2. **Dispatch**: Launch one Sonnet Agent per task/subtask, each with `isolation: 'worktree'`
   - Each Agent gets its own git branch and working directory
   - Agents CAN safely modify the same files (worktree isolation prevents conflicts)
3. **Monitor**: Track each Agent's progress (tool calls, files modified)
4. **Review**: After all Agents complete, Opus reviews each branch's diff
5. **Merge**: Merge changes from each worktree branch into the current branch
   - Use `git merge <branch>` or cherry-pick as needed
   - Resolve conflicts if any arise
6. **Verify**: Run build/test/lint on the merged result
7. **Record**: Update task.json + progress.txt + STATE.md, then commit

**Example Agent dispatch:**
```
Agent(model: 'sonnet', isolation: 'worktree', description: 'implement auth module', prompt: '...')
Agent(model: 'sonnet', isolation: 'worktree', description: 'implement user API', prompt: '...')
```

### Quality Gates

1. **No skipping planning** for non-trivial changes — write a brief plan or design note first
2. **TDD or test-before-complete** for all logic changes — RED → GREEN → REFACTOR
3. **Verification required** — run `build`, `lint`, or `test` before marking done
4. **Review before merge** — Opus reviews every sub-Agent branch diff before merging
5. **Bugs go to `dev/bug_fix/`** with root cause analysis
6. **Reviews go to `dev/review/`** with outcomes and action items
7. **Docs stay aligned** — if implementation changes behavior, update the relevant doc

### Deviation Handling Rules

During execution, agents will encounter unplanned situations. Handle them by severity:

| Level | Situation | Action | Example |
|-------|-----------|--------|---------|
| **D1** | Cosmetic / formatting issue | Auto-fix, log in progress.txt | Trailing whitespace, import order |
| **D2** | Missing dependency or config | Auto-install/create, log in progress.txt | Missing npm package, missing env var stub |
| **D3** | Failing test unrelated to current task | Fix if trivial (<10 lines), otherwise log as blocker and skip | Pre-existing broken test |
| **D4** | Ambiguous requirement or scope conflict | **STOP**. Do NOT guess. Log the ambiguity in STATE.md and mark task as blocked | "Should this API be public or internal?" |
| **D5** | Architectural decision needed | **STOP**. Log in STATE.md, create a planning task, mark current task as blocked | "This needs a new database table" |

**Rules:**
- D1–D3: Auto-handle and continue. Log what you did in `dev/progress.txt`
- D4–D5: Stop execution immediately. Never guess on ambiguous requirements or make architectural decisions without approval
- If in doubt, treat as D4 (stop and ask)
- Never introduce scope creep to "fix" a deviation — address the minimum, log the rest

### Delivery Rules

- Complete the task in the smallest useful slice
- Every task must have clear acceptance criteria before starting
- Record decisions in `.planning/STATE.md` (not just in commit messages)
- Keep docs and implementation aligned
- Prefer explicit over implicit — if something is unclear, record the assumption

### Task Status Lifecycle

```
todo → in_progress → done
                  → blocked (record reason in progress.txt and STATE.md)
```

### Commit Convention

```
<type>(<task-id>): <short description>

Types: feat, fix, refactor, test, docs, chore
Example: feat(T003): add user authentication module
```
