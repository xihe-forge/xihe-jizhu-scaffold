# External Skill Modules

Pluggable, independent skill modules that extend the scaffold's capabilities. Each module has a single responsibility and is invoked by autopilot at the appropriate phase.

## Architecture

```
.ai/skills/
├── skill-registry.json          # Module registry + phase mapping
├── impeccable/                  # Frontend design generation & refinement (git submodule)
│   └── source/skills/
│       ├── frontend-design/SKILL.md  # Core design skill (anti-AI-slop)
│       │   └── reference/            # Typography, color, motion, spatial, interaction, responsive, UX writing
│       ├── teach-impeccable/SKILL.md # One-time design context setup
│       ├── polish/SKILL.md           # Final visual quality pass
│       ├── audit/SKILL.md            # Comprehensive UI audit
│       ├── critique/SKILL.md         # Design effectiveness review
│       ├── harden/SKILL.md           # UI resilience (error, i18n, edge cases)
│       ├── normalize/SKILL.md        # Design system alignment
│       ├── optimize/SKILL.md         # Frontend performance
│       ├── distill/SKILL.md          # Simplify over-designed UI
│       └── extract/SKILL.md          # Extract reusable components/tokens
├── vercel-web-design/           # Engineering-grade UX quality gate (git submodule)
│   └── skills/web-design-guidelines/SKILL.md  # Web Interface Guidelines compliance
└── xihe-rinian-seo/           # SEO & AEO audit + monitoring (git submodule)
    └── skills/
        ├── seo-audit/SKILL.md   # Full SEO audit with Lighthouse
        ├── aeo-audit/SKILL.md   # AI search optimization (9-dimension scoring)
        ├── aeo-monitor/SKILL.md # AI citation tracking + sentiment + competitors
        └── seo-report/SKILL.md  # Before/after comparison & impact analysis
```

## Design Principles

1. **Main architecture is self-contained** — autopilot, intake, review pipeline are the scaffold's own implementation
2. **Skills are independent modules** — each has a clear role and doesn't overlap with core
3. **Complementary, not competing** — impeccable handles visual aesthetics, vercel handles engineering standards
4. **Phase-triggered** — autopilot invokes skills based on current phase and task type

## Integration Methods

All skill modules are managed as **git submodules** and updated via `git submodule update --remote`.

| Module | Source | Update |
|--------|--------|--------|
| impeccable | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `git submodule update --remote .ai/skills/impeccable` |
| vercel-web-design | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | `git submodule update --remote .ai/skills/vercel-web-design` |
| xihe-rinian-seo | [xihe-forge/xihe-rinian-seo](https://github.com/xihe-forge/xihe-rinian-seo) | `git submodule update --remote .ai/skills/xihe-rinian-seo` |

## Phase Mapping

| Phase | impeccable | vercel | xihe-rinian-seo |
|-------|-----------|--------|-------------------|
| Frontend implementation | `frontend-design` (generate) | — | — |
| Frontend review | `critique` + `audit` (aesthetic QA) | `web-design-guidelines` (engineering QA) | — |
| SEO/AEO review | — | — | `seo-audit` → `aeo-audit` → `aeo-monitor` → `seo-report` |
| Final review | `audit` (full audit) | `web-design-guidelines` (compliance) | All 4 skills (search quality gate) |
| Pre-ship polish | `polish` + `normalize` | — | — |

## Adding New Skill Modules

1. Create a directory under `.ai/skills/<module-name>/`
2. Add skill `.md` files with proper frontmatter (`name`, `description`)
3. Register in `skill-registry.json` with trigger conditions and phase mapping
4. Skills are automatically picked up by autopilot's `buildPrompt()` when triggers match
