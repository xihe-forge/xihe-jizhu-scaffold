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
