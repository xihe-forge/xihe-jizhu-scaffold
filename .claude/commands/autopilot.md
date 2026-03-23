<!-- GENERATED FILE — edit the .md.tmpl source, then run: pnpm gen:commands -->
You are operating within the robust-ai-scaffold autonomous delivery system.

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
- xihe-search-forge skills: `.ai/skills/xihe-search-forge/skills/<name>/SKILL.md`


Start the autopilot continuous delivery loop.

Execute the following command:

```bash
node infra/scripts/autopilot-start.mjs $ARGUMENTS
```

Supported flags:
- `--dry-run` — show prompts without executing
- `--once` — run one cycle then stop
- `--continue-review` — resume from `awaiting_user_decision` and add more review rounds
- `--accept-as-is` — resume from `awaiting_user_decision` and accept current state

The autopilot will:
1. Pick the next ready task from `dev/task.json`
2. Build a prompt and dispatch to the configured runner (Claude/Codex/Gemini)
3. Update task status and progress
4. Loop until all tasks are done, then enter final review phase
