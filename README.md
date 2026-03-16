# robust-ai-scaffold

A resilient project scaffold that blends:

- `xihe-ai` style monorepo structure
- `get-shit-done` style planning state
- `workflows` style agent separation
- `superpowers` style discipline around planning, TDD, review, and verification

## Structure

- `apps/`: app entrypoints
- `packages/`: shared code and types
- `docs/`: research, MRD, PRD, tech, design, review
- `dev/`: tasks, progress, bug workflow, review logs
- `test/`: unit, integration, e2e, test cases
- `infra/`: scripts, docker, CI
- `.planning/`: durable planning state for AI and humans
- `.ai/`: runtime-agnostic agent templates and recipes

## Quick Start

```bash
pnpm install
pnpm kickoff
```

The default product flow is:

1. talk with AI to clarify the project idea
2. let AI write `.planning/` and `dev/task.json`
3. choose the AI runtime that will work 24/7
4. verify the repo
5. start autonomous execution when ready

If the AI runtime hits quota or rate limits, intake and autopilot will keep waiting and retrying instead of consuming the normal retry budget.
If kickoff is interrupted entirely, rerun `pnpm kickoff` and it will resume from the saved intake state.

If you prefer the menu, use:

```bash
pnpm start-here
```

For continuous AI execution, use:

```bash
pnpm work
```

To validate the durable kickoff flow itself, maintainers can run:

```bash
pnpm test:intake-resume
```

To switch the AI runtime later, use:

```bash
pnpm autopilot:configure
```

See [TEMPLATE-USAGE.md](./TEMPLATE-USAGE.md) for the conversation-first flow.

## Philosophy

1. Let AI clarify the project before coding.
2. Keep the planning state in the repo.
3. Let autonomous work continue after quota recovers.
4. Use small verifiable tasks and explicit acceptance criteria.
