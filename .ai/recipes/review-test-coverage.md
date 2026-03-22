# Review Recipe: Test Coverage & PRD Completeness Audit

## When to Use

After test implementation is complete for a milestone/phase.
This review ensures **every PRD requirement has corresponding test coverage** — no gaps allowed.

## Required Tools

This review uses the scaffold's built-in TDD methodology and PRD traceability checks. No external skill modules required.

## Core Principle: Full PRD Coverage

**Every requirement in the PRD must have at least one test that verifies it.**
This is not optional. Missing test coverage for a PRD requirement is a blocking failure.

## Review Process

### Step 1: Build the Coverage Matrix

Create a matrix mapping every PRD requirement to its test(s):

```markdown
| PRD Requirement ID | Requirement Description | Test File | Test Name | Status |
|-------------------|------------------------|-----------|-----------|--------|
| REQ-001 | User can create account | auth.test.ts | "creates account with valid email" | COVERED |
| REQ-002 | Password must be 8+ chars | auth.test.ts | "rejects short passwords" | COVERED |
| REQ-003 | User can reset password | — | — | MISSING |
```

### Step 2: Identify Gaps

For each PRD requirement without a test:
1. **Is it testable?** If yes → write the test. If no → flag as D5 (architectural issue).
2. **Is it in scope for this phase?** If yes → must be tested. If deferred → document in ROADMAP.md.
3. **Is it an edge case?** Edge cases still need tests. "Unlikely" is not "untestable".

### Step 3: Validate Test Quality

Apply scaffold TDD methodology:

1. **Independence**: Can each test run in isolation?
2. **Determinism**: Does each test produce the same result every time?
3. **Speed**: Are tests fast enough for CI? (unit < 100ms, integration < 5s)
4. **Clarity**: Does the test name describe the behavior being verified?
5. **No implementation coupling**: Do tests verify behavior, not internal implementation?

### Step 4: Coverage Types

Verify these coverage dimensions:

1. **Functional coverage**: Every user-facing feature has tests
2. **Error path coverage**: Invalid inputs, network failures, edge cases
3. **Integration coverage**: Component interactions tested
4. **Regression coverage**: Previously fixed bugs have regression tests
5. **Acceptance criteria coverage**: Each acceptance criterion from task.json has a test

### Step 5: Nyquist Validation

The Nyquist principle requires:
- **Minimum**: 1 test per acceptance criterion
- **Recommended**: 2+ tests per complex requirement (happy path + error path)
- **Required for security**: 3+ tests for auth, payment, data access features
- **Payment-specific** (if project uses payment integration): checkout flow, webhook idempotency, auth-before-checkout guard, subscription lifecycle (active → cancelled → reactivated). See `.ai/recipes/payment-integration-guide.md` Section 4 for the full E2E test flow.

## Pass / Fail Criteria

- **PASS**: 100% PRD requirements covered, all tests pass, Nyquist satisfied
- **CONDITIONAL PASS**: >90% covered, remaining gaps documented with justification and timeline
- **FAIL**: <90% covered, or any P0 requirement uncovered, or tests don't pass

## Output

Record in `dev/review/REVIEW-TEST-COVERAGE-{phase}.md`:

```markdown
# Test Coverage Review: {phase}

## Coverage Matrix
{full matrix from Step 1}

## Summary
- Total PRD requirements: {N}
- Covered: {M} ({percentage}%)
- Missing: {list with reasons}

## Test Quality
- [ ] All tests independent
- [ ] All tests deterministic
- [ ] All tests fast enough
- [ ] All test names descriptive
- [ ] No implementation coupling

## Nyquist Check
- [ ] Minimum 1 test per acceptance criterion
- [ ] Complex features have 2+ tests
- [ ] Security features have 3+ tests

## Verdict: PASS / CONDITIONAL PASS / FAIL
## Uncovered Requirements: (list with action plan)
```
