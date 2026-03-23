# Review Recipe: Code Generation Audit

## When to Use

After code implementation tasks complete and before merging into the main branch.
This extends the base `review.md` recipe with tool-specific checks.

## Required Tools

| Tool | Path | Purpose |
|------|------|---------|
| **impeccable** | `.ai/skills/impeccable` | Frontend code anti-pattern detection, design audit |
| **vercel-web-design** | `.ai/skills/vercel-web-design` | Engineering UX quality gate (a11y, performance, standards) |

## Stage 0: Scope Drift Check (Informational)

Before reviewing code quality, compare the changed files against the task's stated scope.

1. Read the task description and acceptance criteria from `dev/task.json` (current task)
2. Run `git diff --name-only` to get the list of changed files
3. Compare:
   - **CLEAN**: All changed files are within the expected scope of the task
   - **DRIFT_DETECTED**: Files were changed that are outside the task's scope (list them)
   - **REQUIREMENTS_MISSING**: Some acceptance criteria have no corresponding file changes (list them)

Report the drift status at the top of your review output. This is INFORMATIONAL — it does not block the review, but flags potential issues for the orchestrator.

## Issue Classification & Fix-First Protocol

The reviewer has WRITE permission. Classify every finding and act accordingly:

### AUTO-FIX (fix directly, log what was fixed)
| Category | Examples |
|----------|----------|
| Dead code | Unused imports, unreachable branches, commented-out code |
| Stale comments | Comments that contradict the current code |
| Obvious type errors | `\|\|` where `??` is needed, missing `await`, wrong nullish check |
| N+1 queries | Database calls inside loops |
| Missing error handling | Uncaught promise, missing try/catch at system boundary |
| Formatting/lint | Inconsistent indentation, trailing whitespace (if no auto-formatter) |

### REPORT (do NOT auto-fix, report for triage)
| Category | Examples |
|----------|----------|
| Security design | Auth bypass, injection vectors, secrets exposure |
| Race conditions | Concurrent state mutation, TOCTOU |
| Architecture decisions | API surface changes, abstraction choices |
| Business logic | Validation rules, pricing logic, permission models |
| Performance trade-offs | Caching strategy, query optimization approach |

**Rule**: For AUTO-FIX items, edit the file directly and list the change in your review output under "## Auto-Fixed Issues". For REPORT items, list them under "## Issues Requiring Triage" with severity (CRITICAL/HIGH/MEDIUM) and recommended action.

## Review Checklist

### Stage 1: Spec Compliance (base review.md)

All checks from the base review recipe Stage 1 apply:
1. Acceptance criteria met (check each one)
2. Scope correct (no unrelated changes)
3. Tests exist (1 per acceptance criterion — Nyquist principle)
4. All tests pass

### Stage 2: Code Quality (base review.md)

All checks from the base review recipe Stage 2 apply.

### Stage 3: Development Methodology

Verify development methodology:

1. **TDD compliance**: Was RED-GREEN-REFACTOR followed?
   - Were tests written BEFORE implementation?
   - Do tests fail without the implementation (RED)?
   - Does implementation make tests pass (GREEN)?
   - Was code simplified after tests pass (REFACTOR)?
2. **Verification before completion**:
   - Build passes?
   - Lint passes?
   - Type check passes?
   - All tests pass (not just new ones)?
3. **Systematic debugging**: If bugs were encountered during implementation:
   - Was root cause identified (not just symptoms)?
   - Is the fix targeted (not a workaround)?
   - Does a regression test exist?

### Stage 4: Frontend Quality (impeccable + vercel-web-design)

For tasks that touch UI code, run:

1. **impeccable /audit**: Check implemented UI against design anti-patterns
   - No Inter font as lazy default
   - No purple gradient syndrome
   - No card-in-card-in-card nesting
   - No decorative elements without function
   - Proper dark mode implementation (not just color inversion)
2. **impeccable /optimize**: Performance check
   - No unnecessary re-renders
   - Images optimized
   - Bundle size reasonable
3. **vercel-web-design**: Engineering UX quality gate
   - Accessibility standards met (a11y)
   - Performance benchmarks satisfied
   - Web interface guidelines followed
   - Components follow platform conventions

### Stage 4b: Frontend Practical Checklist (frontend-review-checklist.md)

For tasks that produce user-facing pages, **also** run every item in `.ai/recipes/frontend-review-checklist.md`. Key mandatory checks:

1. **Layout consistency**: All sections use the **same max-width** container. Mixed widths cause misalignment visible when scrolling.
2. **Text centering**: Card content centered by default. Only left-align with structural reason.
3. **Responsive**: Test at the project's target breakpoints (defined in `.planning/config.json` under `responsive_breakpoints`, or default mobile breakpoints if not configured). Check for horizontal overflow, text overlap, and grid collapse.
4. **Auth UI**: Login button must work (not a dead link). Password confirmation on registration. Token key consistent across all files.
5. **Footer**: No `href="#"` placeholder links. Dead links must use `button disabled` + "Coming soon".
6. **Pricing math**: Verify annual savings calculation manually. Checkout must check auth state first.
7. **i18n** (if applicable): Nav labels must fit across all languages. Language toggle must change **all** visible strings.

These items are derived from real production bugs. **Every frontend review must include visual verification** — code-only review is insufficient for layout issues.

### Stage 4c: Error Handling & Logging (error-handling-and-logging.md)

For ALL code (frontend and backend), verify against `.ai/recipes/error-handling-and-logging.md`:

1. **Error safety**: API responses use standard `{ error: { code, message } }` shape. No stack traces, database errors, or internal paths in responses. Grep for `err.message` in frontend display code.
2. **Error codes**: Follow the naming convention (`AUTH_`, `VALIDATION_`, `PAYMENT_`, `INTERNAL_`).
3. **Logging**: All API requests logged with timestamp, userId, method, path, statusCode, duration. Errors logged with errorId + full internal details.
4. **Frontend error reporting**: Error boundary at app root. Errors reported to `/api/log/error`. User sees generic message, not raw error.
5. **No bare console.log**: Production code uses structured logger, not `console.log`.

### Stage 4d: Security Audit (security-audit.md)

For ALL projects, apply the checks in `.ai/recipes/security-audit.md`:

1. **OWASP Top 10**: Walk through each category relevant to the code changed:
   - Broken Access Control: verify ownership checks on every data-access endpoint
   - Injection: confirm all user input goes through parameterized queries or validated schemas
   - Sensitive Data Exposure: no PII in logs, passwords hashed with bcrypt/argon2, HTTPS enforced
   - Broken Authentication: JWT expiry set, HttpOnly cookies, no session fixation
   - Security Misconfiguration: CORS not wildcarded on auth routes, verbose errors off in production
   - XSS: no `innerHTML`/`dangerouslySetInnerHTML` with unescaped user content
2. **Dependency vulnerability scan**: Run `pnpm audit --audit-level=moderate` (or `npm audit`). Any `critical` or `high` advisory blocks the review.
3. **Secrets detection**: Grep source files for API keys, tokens, and hardcoded passwords. Verify `.env` files are in `.gitignore`. Confirm `.env.example` contains only placeholders.

Any `CRITICAL` or `HIGH` finding from the security audit blocks merge, the same as a Stage 1 failure.

### Stage 5: PRD Traceability

1. **Requirement mapping**: Does this code change map to a specific PRD requirement?
2. **No gold-plating**: Is the implementation exactly what was specified, nothing more?
3. **Acceptance criteria coverage**: Can each acceptance criterion be demonstrated?

## Pass / Fail Criteria

- **PASS**: All 5 stages pass, TDD verified, no anti-patterns, security audit clean, PRD traceable
- **FAIL**: Any stage fails → specific feedback to the worker, do NOT merge

## Output

Record in `dev/review/REVIEW-CODE-{TaskID}.md` with all stage results.
