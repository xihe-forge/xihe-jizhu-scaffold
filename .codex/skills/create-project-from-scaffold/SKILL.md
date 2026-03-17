# Create Project From Scaffold

Use this skill when the user wants to create a brand-new project from the robust scaffold.

## Required Inputs

- scaffold source path
- target directory
- project name

## Optional Inputs

- package scope
- project description
- one-line positioning

If scope is not provided, derive it as `@<project-name>`.

## Procedure

1. Confirm or infer the scaffold source path.
2. Copy the scaffold directory to the target directory.
3. Run:

```bash
pnpm install
pnpm kickoff
```

## Deliverable

Report:

- where the new project was created
- whether the AI intake conversation completed
- which name and scope were applied
- which AI runtime was selected for 24/7 work
- whether setup finished cleanly
- whether `pnpm work` is ready
- which planning files still need manual customization
