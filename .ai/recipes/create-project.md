# Create Project Recipe

## Goal

Instantiate a fresh project from this scaffold and customize its identity.

## Inputs

- target folder
- project name
- package scope
- short description
- one-line positioning

## Steps

1. Copy the scaffold into the target folder.
2. Run:

```bash
pnpm install
pnpm kickoff
```

## Minimum Completion Criteria

- AI intake conversation completed
- project identity replaced
- package scope replaced
- AI runtime selected in `.autopilot/config.json`
- planning files initialized
- health check passed
- `pnpm autopilot:doctor` passed
- build passed or a clear stack decision was recorded
- user can start continuous work with `pnpm work`
