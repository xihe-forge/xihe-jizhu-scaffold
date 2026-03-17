# Diagnose Recipe

## When to Use

Bug reports, test failures, or unexpected behavior.

## Flow

1. **Reproduce**: Identify the failing test, error log, or user report
2. **Investigate**: Collect evidence — read logs, stack traces, related code
3. **Hypothesize**: Form 2-3 possible root causes, ranked by likelihood
4. **Verify**: Write a failing test that proves the root cause
5. **Fix**: Implement the minimal fix
6. **Confirm**: Failing test now passes, no regressions
7. **Record**: Write root cause analysis in `dev/bug_fix/`, update progress.txt

## Root Cause Template

```markdown
# Bug: [short title]
## Symptom
[what was observed]
## Root Cause
[why it happened]
## Fix
[what was changed]
## Prevention
[how to prevent recurrence]
```
