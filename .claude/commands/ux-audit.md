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


Run a comprehensive UX audit combining aesthetic and engineering quality gates.

Target: $ARGUMENTS

## Dual Audit

Run both audit modules in sequence:

### 1. Aesthetic Audit (impeccable)
Read and apply `.ai/skills/impeccable/source/skills/audit/SKILL.md`:
- Accessibility, performance, theming, responsive checks
- Anti-AI-slop detection (AI color palette, glassmorphism, gradient text, generic fonts)
- Generate severity-rated findings report

### 2. Engineering Audit (Vercel Web Interface Guidelines)
Read and apply `.ai/skills/vercel-web-design/skills/web-design-guidelines/SKILL.md`:
- Fetch latest guidelines from the source URL in the skill file
- Check against all rules
- Output findings in `file:line` format

## Combined Report

Merge findings from both audits, deduplicate, and present:
- **Critical**: Blocks shipping
- **High**: Should fix before release
- **Medium**: Quality improvement
- **Low**: Nice to have

Include recommended fix actions referencing specific impeccable skills (`/design polish`, `/design normalize`, etc.).
