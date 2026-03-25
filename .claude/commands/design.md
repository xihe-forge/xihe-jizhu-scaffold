<!-- GENERATED FILE — edit the .md.tmpl source, then run: pnpm gen:commands -->
You are operating within the xihe-loom-scaffold autonomous delivery system.

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


Generate or refine frontend UI using the impeccable design system.

This command orchestrates the impeccable skill module for frontend design work.

## Setup Check

First check if `.impeccable.md` exists in the project root. If not, run the teach-impeccable setup:
- Read `.ai/skills/impeccable/source/skills/teach-impeccable/SKILL.md` and follow its instructions to gather design context.

## Design Workflow

Target: $ARGUMENTS

Based on the request, select the appropriate skill:

| Intent | Skill File |
|--------|-----------|
| Create new UI | `.ai/skills/impeccable/source/skills/frontend-design/SKILL.md` |
| Polish before shipping | `.ai/skills/impeccable/source/skills/polish/SKILL.md` |
| Audit quality | `.ai/skills/impeccable/source/skills/audit/SKILL.md` |
| Evaluate design | `.ai/skills/impeccable/source/skills/critique/SKILL.md` |
| Improve resilience | `.ai/skills/impeccable/source/skills/harden/SKILL.md` |
| Align to design system | `.ai/skills/impeccable/source/skills/normalize/SKILL.md` |
| Improve performance | `.ai/skills/impeccable/source/skills/optimize/SKILL.md` |
| Simplify complexity | `.ai/skills/impeccable/source/skills/distill/SKILL.md` |
| Extract components | `.ai/skills/impeccable/source/skills/extract/SKILL.md` |

Read the selected skill file and follow its instructions. 
