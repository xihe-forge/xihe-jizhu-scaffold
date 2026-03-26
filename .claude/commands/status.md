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


Show the current project status at a glance.

Read and summarize the following files:

1. `.planning/STATE.md` — Current phase and status
2. `.planning/config.json` — Configuration (review strategy, enabled modules, user profile)
3. `dev/task.json` — Task queue: count total, done, in-progress, blocked, todo
4. `dev/progress.txt` — Last 20 lines of progress log

Present a concise status table:

| Item | Value |
|------|-------|
| Phase | (from STATE.md) |
| Tasks | X/Y done (Z blocked) |
| Review Strategy | (from config.json) |
| User Profile | (from config.json) |
| Enabled Modules | (from config.json) |
| Last Activity | (from progress.txt) |
