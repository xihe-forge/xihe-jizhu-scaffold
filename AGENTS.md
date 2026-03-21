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

### Role Division: Opus vs Sonnet vs Codex

The autopilot system uses a multi-agent model:

| Role | Model | Responsibilities |
|------|-------|-----------------|
| **Orchestrator** | Opus | Planning, task analysis, review, documentation, merge coordination |
| **Worker (Claude)** | Sonnet | Implementation, testing, bug fixes, refactoring |
| **Worker (Codex)** | GPT (Codex CLI) | Independent module implementation, isolated coding tasks |
| **Worker (Gemini)** | Gemini CLI | Frontend/design tasks, UI implementation |

**Assignment Rules (task.json `assignee` field):**
- `"opus"` — Planning/review task, Opus completes directly
- `"sonnet"` (default) — Coding task, Opus dispatches Sonnet sub-Agents
- `"codex"` — Coding task delegated to Codex CLI via codex-bridge

**General Rules:**
- The main autopilot process ALWAYS runs as Opus (the orchestrator)
- Opus reads the task, decides how to break it down, then dispatches workers
- Every Sonnet sub-Agent MUST use `model: 'sonnet'` and `isolation: 'worktree'`
- Codex tasks use git worktree isolation via the `codex-bridge/` module
- Opus reviews ALL worker output (Sonnet or Codex) before merging

### Codex Delegation Protocol

When a task has `"assignee": "codex"` in task.json:

**Note:** All paths and branch names use a **sanitized task ID** (non-alphanumeric chars except `-_` replaced with `-`).
Example: task `R2-007` → sanitized `R2-007`; task `feat/login` → sanitized `feat-login`.

1. **Prepare context**: Write a self-contained handoff file (`.task-handoff/codex-task-{safeId}.md`) with project conventions, task description, acceptance criteria, and relevant source files
2. **Create worktree**: `git worktree add .worktrees/codex-{safeId} -b codex/{safeId}`
3. **Execute**: `codex exec --full-auto -C .worktrees/codex-{safeId} "Read <absolute-path-to-handoff-file> and execute"`
4. **Review**: Opus reads `git diff HEAD...codex/{safeId}` and evaluates changes
5. **Accept/Reject**: Merge if acceptable, discard and re-specify if not
6. **Cleanup**: Remove worktree and branch (two separate commands for WinPS 5.1 compat)

The `codex-bridge/` directory contains a PowerShell module with helper functions for this workflow. See `codex-bridge/README.md` for details.

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

### Rationalization Blockers

Agents may attempt to justify shortcuts. The following rationalizations are **never acceptable**:

| Blocked Phrase | Why It's Blocked |
|---------------|-----------------|
| "Skip tests for now" / "tests can come later" | Tests are required before marking a task done (Quality Gate #2) |
| "This is just a small change" | Small changes still require verification (Quality Gate #3) |
| "I'll refactor this later" | Deliver clean code now; technical debt is not acceptable in new code |
| "The user won't notice" | All behavior changes must meet acceptance criteria |
| "It works on my machine" | Build and test must pass in the project environment |
| "This is out of scope, but while I'm here..." | Scope creep violates Deviation Rule D4-D5. Log and stop |
| "I can't test this" | If something is untestable, flag it as a D5 architectural issue |
| "The existing code doesn't have tests either" | New code always requires tests regardless of legacy state |
| "Just show the error message to the user" | Internal errors must NEVER be exposed to frontend users (see `.ai/recipes/error-handling-and-logging.md`) |
| "We don't need logging for this" | All API endpoints must have structured logging. No exceptions for "simple" endpoints |

If an agent produces any of these rationalizations, treat it as a **D4 deviation** (stop and log).

### Error Handling & Logging (Mandatory)

All projects built on this scaffold MUST follow `.ai/recipes/error-handling-and-logging.md`:

1. **Error safety**: Frontend never displays raw backend errors. API returns `{ error: { code, message } }`.
2. **Structured logging**: Every request logged with userId, IP, timestamp, method, path, statusCode, duration.
3. **Error reporting**: Frontend errors captured by error boundary and reported to `/api/log/error`.
4. **Error correlation**: Every error gets a unique `errorId` — user can report it, developer can find it in logs.

### Stage-Based Review Gates

The scaffold enforces mandatory reviews at each development stage using specialized opensource tools.
Review gate configuration is in `.planning/config.json` under `review_gates`.

| Stage | Recipe | Opensource Tools | Blocking? |
|-------|--------|-----------------|-----------|
| **MRD/PRD created** | `.ai/recipes/review-mrd-prd.md` | pm-skills, superpowers | YES |
| **Tech/Design docs created** | `.ai/recipes/review-tech-design.md` | impeccable, ui-ux-pro-max-skill, open-lovable, superpowers | YES |
| **Code implementation done** | `.ai/recipes/review-code.md` | superpowers, impeccable, ui-ux-pro-max-skill | YES |
| **Testing complete** | `.ai/recipes/review-test-coverage.md` | superpowers, pm-skills | YES |
| **Marketing materials created** | `.ai/recipes/review-marketing.md` | marketingskills, pm-skills | No (advisory) |

**Supplementary Checklists** (referenced by review recipes):
- `.ai/recipes/frontend-review-checklist.md` — real-world frontend bugs (layout, auth UI, pricing, responsive, i18n). **Mandatory** for all frontend code reviews.
- `.ai/recipes/payment-integration-guide.md` — Creem + Wise setup and E2E test flow. Used when `optional_modules.payment.enabled` is true in config.

**Rules:**
- Blocking reviews MUST pass before proceeding to the next stage
- The test coverage review requires **100% PRD requirement coverage** — every requirement must have at least one test
- Frontend code reviews MUST include the practical checklist — code-only review is insufficient for layout issues
- Review results are recorded in `dev/review/` with structured markdown
- If a review FAILS, the task is returned to the worker with specific gaps listed
- Agents must NOT rationalize skipping reviews (see Rationalization Blockers)

**Review Tool Integration:**

When a task involves files matching a review gate's triggers (e.g., `docs/prd/` triggers `mrd_prd_review`):

1. **Before marking the task done**, the orchestrator must read the corresponding review recipe
2. **Apply each check** from the recipe using the specified opensource tool's methodology
3. **Record the review** in `dev/review/REVIEW-{type}-{id}.md`
4. **Only mark done** if the review verdict is PASS

**PRD-to-Test Coverage Rule:**

Tests must cover the entire PRD. After all implementation tasks in a phase complete:

1. Build a coverage matrix: every PRD requirement → corresponding test(s)
2. Any requirement without a test is a **blocking gap**
3. Nyquist minimum: 1 test per acceptance criterion, 2+ for complex features, 3+ for security

### Final Iteration Review (Multi-AI Convergence)

When ALL tasks in a phase are marked "done", the autopilot enters the **final iteration review** phase.
This is configured in `.planning/config.json` under `final_review`.

**Architecture:**

```
All tasks done → Opus dispatches parallel reviewers → Collect → Triage → Fix → Re-review
```

**Parallel Review Assignments:**

| Domain | Reviewers | What They Check |
|--------|-----------|----------------|
| Documents (MRD, PRD, tech specs) | Opus + Codex CLI (parallel) | MRD completeness, PRD quality, spec-to-code alignment |
| Code & Tests | Sonnet + Codex CLI (parallel) | Code quality, test coverage, PRD coverage matrix, security |

**Triage Process (Opus main agent):**

1. Collect findings from ALL parallel reviewers
2. Deduplicate identical issues found by multiple reviewers
3. Classify: BUG / SECURITY / COVERAGE GAP → must fix; STYLE / FALSE POSITIVE → skip
4. Create fix tasks for must-fix items
5. Dispatch Sonnet or Codex sub-agents to fix (with worktree isolation)
6. After fixes → next review round

**Convergence:** The loop stops when zero new BUG/SECURITY/COVERAGE GAP findings, or max rounds reached.

**Dynamic Max Rounds:** By default (`max_rounds: "auto"` in config), the number of review rounds scales with project complexity:

| Project Size | Tasks | Source Files | Max Rounds |
|---|---|---|---|
| Small | ≤10 | ≤20 | 5 |
| Medium | 11–30 | 21–50 | 7 |
| Large | 31–60 | 51–100 | 10 |
| XL | >60 | >100 | 12 |

The higher tier wins when task count and file count fall in different tiers.

**Review Strategies** (configured during project intake or in `.planning/config.json`):

| Strategy | `review_strategy.mode` | Behavior |
|----------|----------------------|----------|
| Auto | `"auto"` | Scale rounds by project complexity (table above) |
| Zero-bug | `"zero_bug"` | Keep reviewing until bugs < `zero_bug_threshold` (default: 3) |
| Custom | `"custom"` | Use `custom_rounds` as fixed round count |

**User Decision Gate:** When max rounds are reached and unresolved issues remain, the autopilot **pauses** (status: `awaiting_user_decision`) instead of silently finishing. The user sees a summary and chooses:
- `pnpm work --continue-review` → extend with another batch of review rounds
- `pnpm work --accept-as-is` → accept current state, mark review as done

This ensures no issues are swept under the rug — the human always has final say.

### External Skill Modules

The scaffold integrates independent, pluggable skill modules for specialized tasks.
These are **not** part of the core autopilot — they extend it.

| Module | Role | Location |
|--------|------|----------|
| **impeccable** | Frontend design generation & refinement (anti-AI-slop) | `.ai/skills/impeccable/` |
| **vercel-web-design** | Engineering UX quality gate (a11y, performance, standards) | `.ai/skills/vercel-web-design/` |

**How they're used:**
- During **implementation**: autopilot injects impeccable's `frontend-design.md` instructions for frontend tasks
- During **review**: code reviewers apply impeccable `audit.md` (aesthetic) + vercel `web-design-guidelines.md` (engineering)
- During **final review**: both modules are used as parallel quality gates
- **CLI commands**: `/design`, `/ux-audit`, `/review` invoke these skills directly

**Skill dependency chains**: Skills declare `depends_on` in the registry — autopilot topologically sorts and injects them in correct order (e.g., audit before polish).

**Skill execution tracking**: Each task logs `[SKILLS] Task {id}: injected N skills (...)` to `dev/progress.txt`.

Skill registry: `.ai/skills/skill-registry.json`

### Security Audit

All projects undergo automated security review via `.ai/recipes/security-audit.md`:
- OWASP Top 10 checks (injection, XSS, access control, etc.)
- Dependency vulnerability scanning (`pnpm audit`)
- Secrets detection (grep for hardcoded keys/tokens/passwords)
- API security (rate limiting, CORS, input validation)
- Frontend security (CSP, cookie flags, innerHTML ban)

Security findings with CRITICAL or HIGH severity **block** the code review gate.

### Cost & Metrics Tracking

The autopilot tracks per-task cost, tokens, and duration in `dev/metrics.json`:
- Input/output tokens and USD cost captured from runner stream events
- Per-session aggregation with totals
- Accessible via `/cost` CLI command (summary or detail view)

### Deploy Readiness

Run `node infra/scripts/health-check.mjs --deploy-ready` to check production readiness:
- Environment variable completeness (no placeholders)
- Hardcoded secrets scan
- Build verification
- Legal pages (if payment enabled)

### Project Templates

Intake flow offers project type templates: SaaS, Landing Page, API-only, Full-stack.
Templates pre-configure review gates, discipline settings, optional modules, and starter tasks.

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
