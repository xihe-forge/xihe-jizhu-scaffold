# Recipe: Final Iteration Review

## When to Use

Automatically triggered when ALL tasks in the current phase are marked "done".
This is the convergence review loop — it runs until zero new issues are found.

## Architecture

```
All tasks done
    │
    ▼
┌─────────────────────────────────────┐
│     FINAL REVIEW PHASE (Round N)    │
│                                     │
│  Parallel review dispatch:          │
│                                     │
│  ┌─────────────┐ ┌─────────────┐   │
│  │ Opus        │ │ Codex CLI   │   │
│  │ reviews:    │ │ reviews:    │   │
│  │ - MRD/PRD   │ │ - MRD/PRD   │   │
│  │ - tech docs │ │ - tech docs │   │
│  │ - design    │ │ - design    │   │
│  └─────────────┘ └─────────────┘   │
│  ┌─────────────┐ ┌─────────────┐   │
│  │ Sonnet      │ │ Codex CLI   │   │
│  │ reviews:    │ │ reviews:    │   │
│  │ - code      │ │ - code      │   │
│  │ - tests     │ │ - tests     │   │
│  │ - PRD cover │ │ - PRD cover │   │
│  └─────────────┘ └─────────────┘   │
│            │                        │
│            ▼                        │
│  Opus collects ALL findings         │
│  from all parallel reviewers        │
│            │                        │
│     ┌──────┴──────┐                 │
│     │             │                 │
│  No new       Has issues            │
│  issues           │                 │
│     │             ▼                 │
│     │     Opus triages each:        │
│     │     - Real bug? → fix task    │
│     │     - False positive? → skip  │
│     │     - Style only? → skip      │
│     │             │                 │
│     │             ▼                 │
│     │     Dispatch fix agents       │
│     │     (Sonnet or Codex)         │
│     │             │                 │
│     │             ▼                 │
│     │     Next review round (N+1)   │
│     │                               │
│     ▼                               │
│   CONVERGED — Phase complete        │
└─────────────────────────────────────┘
```

## Review Assignments

### Document Review (Opus + Codex in parallel)

Each reviewer independently checks:

1. **MRD completeness** — per review-mrd-prd.md recipe
2. **PRD quality** — acceptance criteria, scope boundaries, testability
3. **Tech spec accuracy** — does spec match implementation?
4. **Design doc alignment** — does design match what was built?

### Code & Test Review (Sonnet + Codex in parallel)

Each reviewer independently checks:

1. **Code quality** — per review-code.md recipe
2. **Test coverage** — per review-test-coverage.md, build PRD coverage matrix
3. **TDD compliance** — per scaffold TDD methodology (RED-GREEN-REFACTOR)
4. **Frontend quality** — per impeccable audit (if frontend exists)
5. **Security** — no hardcoded secrets, proper auth checks

## Triage Rules (Opus Main Agent)

When Opus receives findings from all reviewers:

1. **Deduplicate**: Same issue found by multiple reviewers counts as ONE issue
2. **Classify** each unique finding:
   - **BUG** — Behavior doesn't match PRD/acceptance criteria → MUST FIX
   - **SECURITY** — Vulnerability or exposed secret → MUST FIX (P0)
   - **COVERAGE GAP** — PRD requirement without test → MUST FIX
   - **STYLE** — Formatting, naming convention → SKIP (not worth a fix round)
   - **FALSE POSITIVE** — Reviewer misunderstood → SKIP with justification
   - **ENHANCEMENT** — Good idea but out of scope → LOG in STATE.md for future
3. **Create fix tasks** for all BUG/SECURITY/COVERAGE GAP items
4. **Dispatch** Sonnet or Codex sub-agents to fix (with worktree isolation)
5. **After fixes**: Start next review round

## Convergence Criteria

The review loop STOPS when:

- **Zero new BUG/SECURITY/COVERAGE GAP findings** in a round, OR
- **Max review rounds reached** (auto-scales with project complexity: 3–10 rounds, or set explicitly in config)

If max rounds reached with remaining issues:
- Write ALL unresolved issues to `dev/review/FINAL-REVIEW-UNRESOLVED.md` with severity breakdown
- The autopilot **pauses** (status: `awaiting_user_decision`) and reports to the user
- The user decides next steps:
  - `pnpm work --continue-review` → extend with another batch of review rounds
  - `pnpm work --accept-as-is` → accept current state, mark review as done
- Do NOT silently mark as complete — the human always has final say

## Output

Each round produces `dev/review/FINAL-REVIEW-ROUND-{N}.md`:

```markdown
# Final Review Round {N}

## Reviewers
- Opus: docs review ({N1} findings)
- Codex: docs review ({N2} findings)
- Sonnet: code/test review ({N3} findings)
- Codex: code/test review ({N4} findings)

## Deduplicated Findings ({total} unique)

| # | Finding | Source | Classification | Action |
|---|---------|--------|---------------|--------|
| 1 | Missing test for REQ-003 | Sonnet, Codex | COVERAGE GAP | Fix task created |
| 2 | Auth bypass in /admin | Codex | SECURITY | Fix task created (P0) |
| 3 | Typo in README | Opus | STYLE | Skipped |

## Fix Tasks Created
- FIX-001: Add test for REQ-003 (assignee: sonnet)
- FIX-002: Fix auth bypass (assignee: sonnet, P0)

## Summary
- New issues: {count}
- Fixed from previous round: {count}
- Converged: YES/NO
```
