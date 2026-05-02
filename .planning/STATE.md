# State

## Active Focus

The scaffold is feature-complete and in use for production projects. Current focus is documentation accuracy and type definition hygiene.

## Latest Maintenance

- 2026-05-02: Refreshed pnpm workspace install after rename to xihe-jizhu package scope. apps/api now links @xihe-jizhu-scaffold/types and @xihe-jizhu-scaffold/shared to local packages, with old @robust-ai-scaffold app node_modules scope removed.

## Completed Features

- **Multi-AI autopilot orchestration** -- Opus orchestrates; Sonnet, Codex CLI, and Gemini CLI execute via worktree isolation
- **195 unit tests across 33 test suites** -- covering autopilot core, intake, health checks, utils
- **Quota self-healing** -- dedicated `waiting_quota` state, does not consume retry budget; parses reset times when available
- **codex-bridge & gemini-bridge** -- PowerShell modules for delegating tasks to Codex CLI and Gemini CLI
- **Skill module system** -- impeccable (frontend anti-slop), vercel-web-design (engineering UX), xihe-rinian-seo (SEO/AEO); topological sort, phase mapping, skill registry
- **Project templates** -- SaaS, landing-page, api-only, fullstack; pre-configured review gates and starter tasks
- **Review gates** -- 6 stage-based gates (MRD/PRD, tech design, code, test coverage, marketing, SEO/AEO) plus final iteration multi-AI convergence review
- **Final iteration review** -- parallel reviewers (Opus+Codex for docs, Sonnet+Codex for code), dynamic max rounds, user decision gate
- **Cost & metrics tracking** -- per-task and per-session token/cost/duration in `dev/metrics.json`; `/cost` command
- **Deploy readiness checks** -- env vars, secrets scan, build verification, package.json, legal pages
- **CLI slash commands** -- generated from `.md.tmpl` templates; `/intake`, `/autopilot`, `/review`, `/design`, `/security`, `/deploy-check`, `/cost`, etc.
- **Intake wizard with resume** -- one-click / standard / advanced modes; interrupted sessions resume from saved state
- **Additive project adoption** -- `pnpm adopt` overlays planning layer without touching existing source
- **Project memory system** -- `.autopilot/memory.json` records project decisions and execution patterns for cross-session continuity
- **Autopilot phase extraction** -- `main()` refactored into testable named phase functions
- **Architecture boundary tests** -- CI guards module boundaries to prevent coupling regressions
- **Dangerous operation scanner** -- agent output safety scanning for destructive commands

## Open Decisions

- Whether to add more project templates (e.g., chrome-extension, mobile)
- Skill module versioning strategy (currently uses git submodule HEAD)
