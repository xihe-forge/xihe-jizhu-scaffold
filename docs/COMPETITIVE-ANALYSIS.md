# Competitive Analysis: Code-Level Deep Dive

*Generated 2026-03-17 from deep analysis of 4 projects*

## Projects Analyzed

| Project | Core File | Lines | Architecture |
|---------|-----------|-------|--------------|
| **xihe-loom-scaffold** (ours) | `autopilot-start.mjs` + 12 scripts | ~2000 | Opus orchestrator + Sonnet workers, state machine autopilot |
| **superpowers** | `SKILL.md` + hooks | ~500 | Hard gates via prompt injection, skill auto-triggering |
| **get-shit-done (GSD)** | `gsd-tools.cjs` (598 lines) | ~1200 | Fresh context per executor, wave DAG execution |
| **workflows** | `.claude/commands/*.md` | ~800 | Orchestrator pattern, scale-based dispatch |

---

## Design Decision Comparison

### 1. Context Management

**Our approach**: Opus (orchestrator) uses session resume for persistent project memory. Sonnet (workers) get fresh context via worktree isolation.

**Why**: The orchestrator NEEDS to remember what's done, what's blocked, and what decisions were made across multiple task executions. Workers need clean 200K-token context focused on a single implementation task.

**GSD's approach**: Every executor gets fresh context. The `gsd-tools.cjs` CLI tool reads/writes all state, so the model never needs to "remember" — it re-reads from files each time.

**Why**: GSD observed that long conversations degrade model performance ("context rot"). Their solution is aggressive context isolation — but it requires a heavy state management CLI (598 lines) to compensate.

**Superpowers' approach**: Single session, no explicit context management. Relies on `SKILL.md` being injected at session start via hooks.

**Our advantage**: Best of both worlds — persistent orchestrator memory WITHOUT context rot in workers. GSD's approach is more defensive but requires heavier tooling.

**Our gap**: We don't have a centralized state CLI like GSD's `gsd-tools.cjs`. Our state access is scattered across utility functions.

---

### 2. Parallel Execution

**Our approach**: `getReadyTasks()` returns all dependency-satisfied tasks. Opus dispatches one Sonnet Agent per task with `isolation: 'worktree'`. Each gets its own git branch.

**GSD's approach**: Wave execution — topological sort groups tasks by dependency depth. All tasks in wave N execute in parallel, then wave N+1 starts.

**Workflows' approach**: Scale-based dispatch — 1-2 files = small (direct), 3-5 = medium (plan first), 6+ = large (must decompose into sub-tasks).

**Our advantage**: Real git-level isolation via worktrees. GSD and Workflows use conceptual parallelism but don't enforce branch isolation.

**Our gap**: No wave grouping (could execute tasks from different dependency depths simultaneously). No scale-based decomposition hints.

---

### 3. Quota / Error Handling

**Our approach**: Dedicated state machine (`idle→running→waiting_quota→stopped→error`). Quota failures parsed from stderr, don't consume retry budget. Smart wait with configurable backoff.

**GSD's approach**: No quota handling. Single session assumed.

**Superpowers' approach**: No quota handling. Single session assumed.

**Workflows' approach**: No quota handling. Single session assumed.

**Our advantage**: UNIQUE — we're the only project that handles quota exhaustion as a first-class concern. This is what enables genuine 24/7 operation.

**Our gap**: Quota detection relies on fragile string matching (`indexOf('429')`, `indexOf('rate limit')`). Should parse structured API error responses first.

---

### 4. Quality Gates

**Superpowers' approach**:
- Hard gates via `<HARD-GATE>` tags in SKILL.md — injected into every session via hooks
- Rationalization blockers table: explicit list of AI shortcuts that are BLOCKED (e.g., "Tests are too simple to need" → BLOCKED)
- Two-stage review: Stage 1 checks spec compliance, Stage 2 checks code quality

**GSD's approach**:
- Nyquist validation: every requirement must map to at least one automated test
- Goal-backward verification: truths → artifacts → key links chain
- Deviation rules R1-R4: R1-R3 auto-fix and log, R4 stops for human

**Our approach**: Review recipe in `.ai/recipes/review.md`, verification step (build/test/lint), review before merge.

**Our advantage**: Integrated into the autopilot loop — review happens automatically, not just when manually triggered.

**Our gap**: No rationalization blockers (AI can talk itself out of writing tests). No Nyquist validation (no requirement→test traceability). No deviation rules (unplanned work has no guidance). Review is single-pass, not two-stage.

---

### 5. Project Scaffolding & Adoption

**Our approach**: Full intake interview → AI generates project plan → structured files written. Adopt flow for existing projects (additive-only overlay).

**All others**: No scaffolding capability. They assume a project already exists.

**Our advantage**: UNIQUE — end-to-end from "I have an idea" to "AI is shipping code". The adopt flow is also unique — no other project can overlay governance onto an existing codebase.

---

## Summary: Strengths & Gaps

### Our Unique Strengths (no competitor has these)
1. **24/7 autopilot with quota self-healing** — the only continuous execution engine
2. **Project scaffolding + adopt flow** — from idea to running autopilot in one command
3. **Multi-runtime support** — Claude Code, Codex CLI, custom CLI
4. **Durable state with crash recovery** — all state in plain files, resume from any interruption
5. **Two-tier model hierarchy** — matches model capability to task type

### Gaps to Close (derived from competitor strengths)
1. **File locking** — concurrent corruption risk (GSD solves with centralized CLI)
2. **Circular dependency detection** — silent blocking (GSD's topological sort catches this)
3. **Task execution timeout** — hung agents block indefinitely
4. **Rationalization blockers** — AI can skip quality steps (Superpowers blocks this explicitly)
5. **Deviation rules** — no guidance for unplanned work (GSD's R1-R4)
6. **Two-stage review** — our single-pass review is weaker (Superpowers' two-stage)
7. **Requirement→test traceability** — no Nyquist validation (GSD)
8. **Scale-based decomposition** — no file-count heuristics (Workflows)
9. **Unit tests** — autopilot core has zero tests

### Commercial Viability Assessment

**Can this be a paid product?** Yes, but only with the right positioning:
- The 24/7 autopilot + quota self-healing is genuinely novel — no OSS competitor does this
- Project scaffolding + adopt reduces the "cold start" problem that kills AI tool adoption
- Multi-runtime avoids vendor lock-in (critical for enterprise)

**Risk**: If Claude Code / Codex add native autopilot mode, the execution engine becomes commoditized. The durable value is in the **planning layer** (structured state, quality gates, task management) and the **adoption flow** (bring any project under governance).

**Differentiation path**: Focus on "AI governance for software teams" rather than "another AI coding tool". The planning layer + quality gates + audit trail is what enterprises actually need.
