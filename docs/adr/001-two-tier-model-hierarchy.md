# ADR-001: Two-Tier Model Hierarchy (Opus + Sonnet)

## Status
Accepted

## Context
AI coding assistants typically use a single model for all operations. This creates a tension:
- Strong models (Opus) are expensive and slow, but make better planning/review decisions
- Fast models (Sonnet) are cheap and fast, but make worse architectural decisions
- Long conversations degrade model performance ("context rot"), especially for implementation tasks
- The orchestrator needs persistent memory (what's done, what's blocked, past decisions)
- Workers need clean, focused context for each implementation task

Competing approaches:
- **GSD**: Uses fresh context for everything, compensates with a 598-line CLI tool for state management
- **Superpowers**: Uses a single model, injects context via hooks at session start
- **Workflows**: Uses a single model with orchestrator pattern in prompts

## Decision
Use a two-tier model hierarchy:
- **Opus** runs as the persistent orchestrator (planning, review, merge coordination)
- **Sonnet** runs as disposable workers (implementation, testing, bug fixes)
- Every Sonnet worker runs in **worktree isolation** (own git branch + working directory)

The orchestrator maintains session continuity (resume). Workers are always fresh.

## Consequences

### Positive
- Orchestrator retains project memory across rounds without re-reading everything
- Workers get clean 200K-token context focused on a single task — no context rot
- Cost-efficient: expensive model only used for decisions, cheap model for volume
- Parallel execution is safe: worktree isolation prevents git conflicts

### Negative
- More complex than single-model approach
- Orchestrator session resume depends on Claude Code's session persistence
- If session is lost, orchestrator must re-read all state files (graceful degradation)

### Risks
- If Claude Code deprecates session resume, we lose the persistent memory advantage
- Mitigation: all state is in plain files, so orchestrator can always cold-start by reading them
