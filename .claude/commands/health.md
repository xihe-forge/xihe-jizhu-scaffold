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


Run the project health check to verify environment and configuration.

Execute the following command:

```bash
node infra/scripts/health-check.mjs
```

This checks:
- Required tools installed (git, node, pnpm/npm)
- `.planning/` directory structure exists
- `dev/task.json` is valid
- Runner (Claude CLI / Codex / Gemini) is available
- Payment API keys (if payment module enabled)
- Environment variables in `.env` / `.env.local`
