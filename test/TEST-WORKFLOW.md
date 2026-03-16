# Test Workflow

## Test Pyramid

- `test/unit/`: logic and utilities
- `test/integration/`: module interactions
- `test/e2e/`: critical user journeys

## Rules

- Use unit tests for domain logic.
- Use integration tests for boundaries between components or services.
- Use e2e only for the small set of flows that define product value.

## Completion

Every substantial feature should have:

- at least one explicit verification step
- a note about where future tests belong if tests are deferred
