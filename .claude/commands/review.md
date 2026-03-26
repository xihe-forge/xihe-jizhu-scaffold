<!-- GENERATED FILE — edit the .md.tmpl source, then run: pnpm gen:commands -->
You are operating within the xihe-jizhu-scaffold autonomous delivery system.

## Before You Begin
1. Read `AGENTS.md` for repo rules and delivery standards
2. Read `.planning/STATE.md` for current project status

## Completion Protocol
End your output with exactly one status line:
- `STATUS: DONE` — task completed successfully
- `STATUS: DONE_WITH_CONCERNS` — completed but reviewer should check concerns listed above
- `STATUS: BLOCKED` — cannot proceed, reason stated above
- `STATUS: NEEDS_CONTEXT` — missing information, question stated above

## Skill Paths
When referencing skill files, use the correct submodule paths:
- impeccable skills: `.ai/skills/impeccable/source/skills/<name>/SKILL.md`
- vercel-web-design skills: `.ai/skills/vercel-web-design/skills/<name>/SKILL.md`
- xihe-rinian-seo skills: `.ai/skills/xihe-rinian-seo/skills/<name>/SKILL.md`


Trigger a code review on the current working state.

You have WRITE permission for mechanical fixes. See the Fix-First Protocol in the review recipe.

Read and apply the following review recipes in order:

1. `.ai/recipes/review-code.md` — Code quality, structure, patterns
2. `.ai/recipes/review-test-coverage.md` — Test coverage and TDD compliance
3. `.ai/recipes/frontend-review-checklist.md` — Frontend practical checklist (if frontend code exists)
4. `.ai/recipes/error-handling-and-logging.md` — Error safety and logging standards

For frontend code, also apply the external skill modules:
- `.ai/skills/impeccable/source/skills/audit/SKILL.md` — Visual quality and anti-AI-slop audit
- `.ai/skills/impeccable/source/skills/critique/SKILL.md` — Design effectiveness review
- `.ai/skills/vercel-web-design/skills/web-design-guidelines/SKILL.md` — Web Interface Guidelines compliance

Target files or pattern: $ARGUMENTS

If no target specified, review all files changed since the last commit:
```bash
git diff --name-only HEAD~1
```

Output findings in structured format with severity (Critical/High/Medium/Low) and category.
