# Contributing

## Running Tests

```bash
pnpm test:unit
```

This runs the unit test suite using `node --test`. All tests must pass before submitting a pull request.

## Submitting Pull Requests

1. Fork the repository and create a feature branch from `main`.
2. Make your changes with minimal scope -- one concern per PR.
3. Ensure `pnpm test:unit` passes locally.
4. Open a pull request against `main` with a clear description of what changed and why.

## Development Workflow

See [DEVELOPMENT-WORKFLOW.md](./DEVELOPMENT-WORKFLOW.md) for the full development process, branching conventions, and review expectations.
