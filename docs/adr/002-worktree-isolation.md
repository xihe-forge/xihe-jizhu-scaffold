# ADR-002: Worktree Isolation for Parallel Agents

## Status
Accepted

## Context
When multiple AI agents work in parallel, they can conflict:
- Two agents editing the same file simultaneously cause data loss
- Git operations (add, commit) from parallel agents corrupt the index
- Merge conflicts are difficult for AI agents to resolve reliably

Competing approaches:
- **GSD**: Wave execution — serialize by dependency depth, no true parallel file access
- **Workflows**: Conceptual parallelism — agents are told to work on different files, but no enforcement
- **Superpowers**: Worktree isolation — each agent gets its own git working directory

## Decision
Every coding sub-agent (Sonnet worker) runs with `isolation: 'worktree'`, which creates a temporary git worktree:
- Agent gets its own branch and working directory
- Agent can modify any file without conflicting with other agents
- After completion, the orchestrator (Opus) reviews and merges each branch

## Consequences

### Positive
- True parallel execution — agents can even modify the same files safely
- Clean git history — each agent's work is on a named branch
- Review before merge — orchestrator sees the full diff before integrating
- Rollback is trivial — just delete the branch if the work is rejected

### Negative
- Disk space: each worktree is a full working copy (mitigated by git's shared object store)
- Merge conflicts: if two agents modify the same file, orchestrator must resolve
- Slower setup: creating a worktree takes a few seconds per agent

### Trade-offs
We chose safety over speed. Wave execution (GSD) is simpler but serializes work unnecessarily. Our approach maximizes parallelism while guaranteeing isolation.
