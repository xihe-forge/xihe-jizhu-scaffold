# External Skill Modules

Pluggable, independent skill modules that extend the scaffold's capabilities. Each module has a single responsibility and is invoked by autopilot at the appropriate phase.

## Architecture

```
.ai/skills/
├── skill-registry.json          # Module registry + phase mapping
├── impeccable/                  # Frontend design generation & refinement
│   ├── frontend-design.md       # Core design skill (anti-AI-slop)
│   ├── teach-impeccable.md      # One-time design context setup
│   ├── polish.md                # Final visual quality pass
│   ├── audit.md                 # Comprehensive UI audit
│   ├── critique.md              # Design effectiveness review
│   ├── harden.md                # UI resilience (error, i18n, edge cases)
│   ├── normalize.md             # Design system alignment
│   ├── optimize.md              # Frontend performance
│   ├── distill.md               # Simplify over-designed UI
│   ├── extract.md               # Extract reusable components/tokens
│   └── reference/               # Typography, color, motion, spatial, interaction, responsive, UX writing
└── vercel-web-design/           # Engineering-grade UX quality gate
    └── web-design-guidelines.md # Web Interface Guidelines compliance
```

## Design Principles

1. **Main architecture is self-contained** — autopilot, intake, review pipeline are the scaffold's own implementation
2. **Skills are independent modules** — each has a clear role and doesn't overlap with core
3. **Complementary, not competing** — impeccable handles visual aesthetics, vercel handles engineering standards
4. **Phase-triggered** — autopilot invokes skills based on current phase and task type

## Phase Mapping

| Phase | impeccable | vercel |
|-------|-----------|--------|
| Frontend implementation | `frontend-design` (generate) | — |
| Frontend review | `critique` + `audit` (aesthetic QA) | `web-design-guidelines` (engineering QA) |
| Final review | `audit` (full audit) | `web-design-guidelines` (compliance) |
| Pre-ship polish | `polish` + `normalize` | — |

## Adding New Skill Modules

1. Create a directory under `.ai/skills/<module-name>/`
2. Add skill `.md` files with proper frontmatter (`name`, `description`)
3. Register in `skill-registry.json` with trigger conditions and phase mapping
4. Skills are automatically picked up by autopilot's `buildPrompt()` when triggers match
