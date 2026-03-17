# ADR-004: Additive-Only Project Adoption

## Status
Accepted

## Context
Most AI scaffolds only support creating new projects from scratch. But many teams have existing codebases they want to bring under AI-governed development. The adoption flow must:
- Not break existing project structure, configs, or tooling
- Not overwrite any existing files
- Add the planning layer without requiring migration
- Work with any tech stack (not just TypeScript monorepos)

No competing project offers this capability.

## Decision
Implement an `adopt` command (`pnpm adopt`) that:

1. **Scans** the existing project (package.json, directory structure, monorepo detection)
2. **Interviews** the user (3 questions: project goal, current state, what to build next)
3. **Generates** planning files via AI (PROJECT.md, REQUIREMENTS.md, ROADMAP.md, STATE.md, task.json)
4. **Writes additively** — only creates files that don't already exist, never overwrites
5. **Configures runtime** — sets up .autopilot/config.json for the chosen AI runtime

The key constraint is **additive-only**: if a file already exists at the target path, it is skipped with a log message. This makes adoption safe to run multiple times and impossible to accidentally destroy work.

## Consequences

### Positive
- Zero risk of breaking existing projects
- Idempotent: running adopt twice is safe
- Works with any project structure (not just scaffold-created projects)
- Low barrier to entry: teams can try AI governance without commitment

### Negative
- Generated planning files may not perfectly match existing project state
- User must manually reconcile if planning files conflict with reality
- AI-generated plans depend on the quality of the 3-question interview

### Trade-offs
We chose safety (never overwrite) over convenience (auto-update existing files). Users who want to update planning files can edit them manually or delete and re-adopt.
