Trigger a code review on the current working state.

Read and apply the following review recipes in order:

1. `.ai/recipes/review-code.md` — Code quality, structure, patterns
2. `.ai/recipes/review-test-coverage.md` — Test coverage and TDD compliance
3. `.ai/recipes/frontend-review-checklist.md` — Frontend practical checklist (if frontend code exists)
4. `.ai/recipes/error-handling-and-logging.md` — Error safety and logging standards

For frontend code, also apply the external skill modules:
- `.ai/skills/impeccable/audit.md` — Visual quality and anti-AI-slop audit
- `.ai/skills/impeccable/critique.md` — Design effectiveness review
- `.ai/skills/vercel-web-design/web-design-guidelines.md` — Web Interface Guidelines compliance

Target files or pattern: $ARGUMENTS

If no target specified, review all files changed since the last commit:
```bash
git diff --name-only HEAD~1
```

Output findings in structured format with severity (Critical/High/Medium/Low) and category.
