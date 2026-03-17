# Review Recipe

## When to Use

Before merging any sub-Agent branch or completing a non-trivial task.

## Stage 1: Spec Compliance

Check whether the implementation matches the task requirements. Stage 1 failure **blocks** Stage 2.

1. **Acceptance criteria**: Does the change satisfy EVERY criterion in the task? Check them one by one.
2. **Scope**: Is the change scoped to the task? No unrelated modifications?
3. **Tests exist**: Is there at least one test per acceptance criterion? (Nyquist principle)
4. **Tests pass**: Do all tests pass, including pre-existing ones?

If ANY Stage 1 check fails → **REJECT**. Do not proceed to Stage 2. Return the change to the worker with specific failure reasons.

## Stage 2: Code Quality

Only enter Stage 2 after Stage 1 passes.

1. **Docs alignment**: If behavior changed, are docs updated?
2. **No coupling**: Does the change introduce unnecessary shared-code coupling?
3. **No secrets**: No hardcoded credentials, API keys, or sensitive data?
4. **Error handling**: Are edge cases handled at system boundaries?
5. **Naming**: Are names clear and consistent with existing patterns?
6. **Simplicity**: Is this the simplest solution that meets the criteria?

## Rationalization Blockers

AI agents commonly rationalize skipping quality steps. The following excuses are **BLOCKED** — if you catch yourself or a sub-agent using them, the review FAILS:

| Rationalization | Verdict | Why It's Blocked |
|---|---|---|
| "This is too simple to need tests" | **BLOCKED** | Simple code has simple tests. No excuse. |
| "I'll add error handling later" | **BLOCKED** | Later never comes in autonomous execution. |
| "This doesn't affect existing behavior" | **MUST PROVE** | Show the passing test or diff that proves it. |
| "Not needed for MVP / can be deferred" | **BLOCKED** | If it's in the acceptance criteria, it's needed now. |
| "The test would just duplicate the implementation" | **BLOCKED** | Tests verify behavior, not implementation. Rewrite the test. |
| "This is just a refactor, no new tests needed" | **BLOCKED** | Refactors need tests proving behavior is preserved. |
| "Edge case is unlikely in practice" | **BLOCKED** | Unlikely ≠ impossible. Handle or document the limitation. |
| "I'll clean this up in a follow-up task" | **BLOCKED** | Clean it up now. Follow-ups are forgotten by stateless agents. |

## Output

Record review outcome in `dev/review/` with:

```markdown
# Review: [Task ID]

## Stage 1: Spec Compliance
- [ ] All acceptance criteria met
- [ ] Scope is correct (no unrelated changes)
- [ ] Tests exist for each criterion
- [ ] All tests pass

## Stage 2: Code Quality
- [ ] Docs aligned
- [ ] No unnecessary coupling
- [ ] No secrets
- [ ] Edge cases handled
- [ ] Names clear and consistent
- [ ] Simplest solution

## Rationalization Check
- [ ] No blocked rationalizations detected

## Verdict: PASS / FAIL
## Issues Found: (if any)
## Action Items: (if any)
```
