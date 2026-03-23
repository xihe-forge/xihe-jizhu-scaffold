# Robust AI Scaffold

A production-grade scaffold for **autonomous AI software development** -- combining durable planning state, 24/7 autopilot execution, and intelligent quota self-healing.

Built for teams that want AI agents to ship code continuously, not just respond to prompts.

## What This Does

You describe a project idea. The scaffold:

1. **Interviews** you to clarify scope, requirements, and priorities
2. **Generates** a structured project plan (tasks, milestones, acceptance criteria)
3. **Executes autonomously** using a multi-agent model (Opus orchestrates, Sonnet/Codex implement)
4. **Survives interruptions** -- quota exhaustion, rate limits, process crashes -- and resumes where it left off

The result is a self-governing development loop that runs until the work is done.

## Key Design Decisions

### Multi-Agent Model (Opus + Sonnet + Codex)

The autopilot always runs the strongest model (Opus) as orchestrator. Opus reads the task queue, analyzes dependencies, plans decomposition, and dispatches workers for implementation. Workers can be:

- **Sonnet sub-agents** -- launched with worktree isolation (each gets its own git branch and working directory)
- **Codex CLI** -- delegated via the `codex-bridge/` PowerShell module for independent coding tasks
- **Gemini CLI** -- delegated via the `gemini-bridge/` PowerShell module for frontend/design tasks
- **Opus direct** -- planning/review tasks completed by the orchestrator itself

Task assignment is controlled by the `assignee` field in `dev/task.json` (`"sonnet"`, `"codex"`, or `"opus"`).

### Quota Self-Healing

When the AI runtime hits rate limits or quota exhaustion, most tools crash or burn retries. This scaffold recognizes quota failures as a distinct category -- they don't consume the normal retry budget. The autopilot enters a `waiting_quota` state, parses reset times when available, and resumes automatically. A 24-hour run that hits multiple quota walls still completes all tasks.

### Durable Planning State

All planning artifacts live in `.planning/` as plain files:

| File | Purpose |
|------|---------|
| `PROJECT.md` | Identity, positioning, target users |
| `REQUIREMENTS.md` | In-scope, out-of-scope, constraints |
| `ROADMAP.md` | Milestones and phase sequence |
| `STATE.md` | Current status, blockers, next step, decisions |

The AI reads these before every round. Humans can edit them directly. There's no database, no server, no lock-in -- just files in your repo.

### Additive-Only Project Adoption

Got an existing project? `pnpm adopt` overlays the planning layer without touching your source code, configs, or project structure. It scans your repo, interviews you about goals, and generates the planning files. Existing files are never overwritten.

## Architecture

```
robust-ai-scaffold/
├── .planning/          # Durable planning state (PROJECT, REQUIREMENTS, ROADMAP, STATE, config.json)
├── .autopilot/         # Runtime config and state (model selection, retry policy, session state)
├── .ai/
│   ├── recipes/        # Agent playbooks (implement, review, diagnose, adopt, security-audit, etc.)
│   ├── skills/         # External skill modules (impeccable, vercel-web-design)
│   └── templates/      # Project type templates (saas, landing-page, api-only, fullstack)
├── .claude/commands/   # CLI slash commands (/intake, /autopilot, /review, etc.)
├── apps/               # Application entrypoints (web, api)
├── packages/           # Shared code and types
├── docs/               # Research, MRD, PRD, tech specs, design docs
├── dev/                # task.json, progress.txt, metrics.json, bug fixes, review logs
├── test/               # Unit tests (109 tests across 14 test suites)
├── infra/scripts/      # Autopilot engine, intake flow, health checks
│   └── lib/            # Shared utilities (ai-runner, autopilot-runner, project-setup, utils)
├── codex-bridge/       # PowerShell module for Codex CLI delegation
├── gemini-bridge/      # PowerShell module for Gemini CLI delegation
├── AGENTS.md           # Agent behavior rules (read before every round)
└── package.json        # All commands: kickoff, work, adopt, health, etc.
```

## Quick Start

### New Project

```bash
git clone https://github.com/xihe-forge/robust-ai-scaffold.git my-project
cd my-project
pnpm install
pnpm kickoff
```

The intake flow will:
- Choose your configuration mode (one-click / standard / advanced)
- Ask you to describe your project idea
- Generate clarification questions via AI, then produce structured planning files and a task queue
- Configure review strategy and AI runtime (standard/advanced modes)
- Auto-verify and start autopilot (one-click mode) or confirm manually

### Configuration Modes

| Mode | Who it's for | What it asks |
|------|-------------|-------------|
| **One-click** | Get started fast | Project description + clarification only. Auto-starts autopilot |
| **Standard** | Most users | + Review strategy + AI runtime selection |
| **Advanced** | Power users | + Parallelization, TDD, code review toggles, bug threshold |

### Review Strategies

Configured in `.planning/config.json` under `review_strategy`:

| Strategy | `mode` value | Behavior |
|----------|-------------|----------|
| **Auto** (default) | `"auto"` | Review rounds scale with project complexity (5--12) |
| **Zero-bug** | `"zero_bug"` | Keep reviewing until remaining bugs < threshold (default: 3) |
| **Custom** | `"custom"` | User specifies exact number of review rounds via `custom_rounds` |

### Adopt Existing Project

```bash
cd your-existing-project
# Copy scaffold files into the project, then:
pnpm adopt
```

### Start Autonomous Work

```bash
pnpm work
```

The autopilot will:
- Read `AGENTS.md` and `.planning/STATE.md`
- Pick the highest-priority task with all dependencies satisfied (cycle-safe)
- Dispatch parallel sub-agents when multiple tasks are ready
- Inject applicable review gates and skill instructions into the prompt
- Review, merge, and verify before marking tasks complete
- Handle quota/rate limits automatically (dedicated state, does not consume retry budget)
- Loop until all tasks are done, then enter final review

### npm Scripts

```bash
pnpm start-here          # Interactive menu
pnpm kickoff             # Run project intake wizard (alias: pnpm setup, pnpm talk)
pnpm work                # Start autopilot loop (alias: pnpm autopilot:start)
pnpm health              # Validate project structure
pnpm plan:status         # Show planning state
pnpm adopt               # Overlay planning layer onto existing project
pnpm autopilot:configure # Change AI runtime / model selection
pnpm autopilot:status    # Show autopilot status
pnpm autopilot:stop      # Stop the autopilot gracefully
pnpm autopilot:doctor    # Diagnose autopilot issues
pnpm nyquist             # Run Nyquist validation check
pnpm skill:update        # Update skill submodules to latest remote
pnpm skill:add           # Add an external skill module (git submodule)
pnpm skill:create        # Create a new custom skill from template
pnpm dashboard           # Open autopilot dashboard
pnpm test:unit           # Run unit tests (node --test)
pnpm dev                 # Start dev servers (turbo)
pnpm build               # Build all packages (turbo)
pnpm typecheck           # Type-check all packages (turbo)
pnpm lint                # Lint all packages (turbo)
pnpm test                # Run all tests (turbo)
```

### CLI Slash Commands

Available via `.claude/commands/`:

| Command | Purpose |
|---------|---------|
| `/intake` | Run project intake wizard |
| `/autopilot` | Start autopilot loop |
| `/health` | Run health checks |
| `/status` | Show project status at a glance |
| `/review [files]` | Code + frontend review |
| `/design [target]` | Frontend design generation/refinement (impeccable) |
| `/ux-audit [files]` | Dual UX audit (aesthetic + engineering) |
| `/security [files]` | OWASP Top 10 + secrets + dependency vulnerability scan |
| `/deploy-check` | Production deployment readiness check |
| `/cost [detail]` | Cost and token usage report |

## External Skill Modules

The scaffold's core architecture (autopilot, intake, review pipeline) is self-contained. External skill modules extend it for specialized frontend quality:

| Module | Role | Source |
|--------|------|--------|
| **impeccable** | Frontend design generation & refinement, anti-AI-slop aesthetics (9 skills + 7 reference docs) | [impeccable](https://github.com/pbakaus/impeccable) |
| **vercel-web-design** | Engineering UX quality gate (accessibility, performance, standards) | [vercel-labs](https://github.com/vercel-labs/agent-skills) |
| **xihe-search-forge** | SEO/GEO/AEO audit, AI search engine optimization, structured data validation | [xihe-forge](https://github.com/xihe-forge/xihe-search-forge) |

These three modules are **complementary**: impeccable handles visual aesthetics (anti-AI-slop), Vercel handles engineering standards (a11y, performance, UX), and xihe-search-forge handles search discoverability (SEO/GEO/AEO). All are used together during reviews and final iteration.

Skill registry: `.ai/skills/skill-registry.json`
- Skills declare `depends_on` edges (e.g., `polish` depends on `audit`)
- Autopilot topologically sorts skills and injects them in correct order
- Each task logs which skills were injected to `dev/progress.txt`

**Phase mapping** (from `skill-registry.json`):

| Phase | Skills injected |
|-------|----------------|
| `implement_frontend` | `impeccable/frontend-design` |
| `review_frontend` | `impeccable/critique` -> `vercel-web-design/web-design-guidelines` -> `impeccable/audit` -> `impeccable/normalize` -> `impeccable/polish` |
| `final_review` | `impeccable/audit` -> `vercel-web-design/web-design-guidelines` |

## Project Templates

The intake wizard offers project type templates to pre-configure the scaffold:

| Template | Review Gates | Payment | TDD |
|----------|-------------|---------|-----|
| **SaaS** | MRD/PRD, Tech/Design, Code, Test, Marketing | Enabled | On |
| **Landing Page** | Code + Marketing only | Off | Off |
| **API-only** | MRD/Tech/Code/Test | Off | On |
| **Full-stack** | MRD/Tech/Code/Test | Off | On |
| **Custom** | Manual configuration | -- | -- |

Templates also provide starter tasks and suggested phases. Select during intake.

Template files: `.ai/templates/{saas,landing-page,api-only,fullstack}.json`

## Cost & Metrics Tracking

The autopilot tracks per-task cost and token usage in `dev/metrics.json`:
- Per-task: model, input/output tokens, cost USD, duration, status
- Per-session: cumulative totals (tasks completed, total tokens, total cost, total duration)
- View with `/cost` (summary) or `/cost detail` (per-task breakdown)

## Stage-Based Review Gates

The scaffold enforces mandatory reviews at each development stage. Review gate configuration is in `.planning/config.json` under `review_gates`.

```
MRD/PRD Created -------> review-mrd-prd.md        [BLOCKING]
                              |
Tech/Design Docs ------> review-tech-design.md     [BLOCKING]
                              |
Code Implementation ---> review-code.md            [BLOCKING]
                              |
Testing Complete ------> review-test-coverage.md   [BLOCKING]  (100% PRD coverage required)
                              |
Marketing -------------> review-marketing.md       [Advisory]
                              |
SEO/AEO (web deploy) -> review-seo-aeo.md         [Advisory]
                              |
All Tasks Complete ----> review-final-iteration.md [BLOCKING]  (multi-AI convergence)
```

Each gate specifies:
- **Recipe**: the review playbook to follow (in `.ai/recipes/`)
- **Tools**: opensource skill modules referenced during review
- **Triggers**: file path patterns that activate the gate
- **Blocking**: whether the gate must pass before proceeding

**Supplementary checklists** referenced by review recipes:
- `.ai/recipes/frontend-review-checklist.md` -- real-world frontend bugs (layout, auth UI, pricing, responsive, i18n). Mandatory for all frontend code reviews.
- `.ai/recipes/payment-integration-guide.md` -- Creem + Wise setup and E2E test flow. Used when `optional_modules.payment.enabled` is true.
- `.ai/recipes/security-audit.md` -- OWASP Top 10, dependency scanning, secrets detection, API security, frontend security.
- `.ai/recipes/error-handling-and-logging.md` -- error safety and structured logging standards. Mandatory for all projects.

**PRD-to-Test coverage rule**: Tests must cover the entire PRD. The test coverage review builds a coverage matrix (every PRD requirement -> corresponding tests) and blocks on any gaps.

## Final Iteration Review (Multi-AI Convergence)

When all tasks complete, the autopilot enters a **final review loop** where multiple AI models audit the entire deliverable in parallel:

```
All tasks done
    |
    v
+--------------------------------------+
| Opus dispatches parallel reviewers:  |
|                                      |
|  Docs: Opus + Codex CLI (parallel)   |
|  Code: Sonnet + Codex CLI (parallel) |
|                                      |
|         v                            |
|  Opus collects & triages findings    |
|  (dedup, classify, filter)           |
|         |                            |
|    +----+----+                       |
|    |         |                       |
| No issues  Has bugs                  |
|    |         |                       |
|    v         v                       |
| CONVERGED  Fix via Sonnet/Codex      |
|            -> next review round      |
+--------------------------------------+
```

Each reviewer operates independently using the review recipes and opensource tools. Opus acts as triage -- only BUG, SECURITY, and COVERAGE GAP findings get fixed; STYLE and FALSE POSITIVE are skipped.

**Dynamic max rounds** (when `review_strategy.mode` is `"auto"`):

| Project Size | Tasks | Source Files | Max Rounds |
|---|---|---|---|
| Small | <= 10 | <= 20 | 5 |
| Medium | 11--30 | 21--50 | 7 |
| Large | 31--60 | 51--100 | 10 |
| XL | > 60 | > 100 | 12 |

The higher tier wins when task count and file count fall in different tiers.

**User decision gate**: When max rounds are reached and unresolved issues remain, the autopilot **pauses** (`awaiting_user_decision`) instead of silently finishing. The user chooses:
- `pnpm work --continue-review` -- extend with another batch of review rounds
- `pnpm work --accept-as-is` -- accept current state, mark review as done

## Autopilot State Machine

```
                    +---------------------------+
                    |                           |
                    v                           |
              +----------+    exit=0     +------+-----+
  start ----->|  idle    |<--------------| running    |
              +----+-----+              +--+---+-----+
                   |                       |   |
                   | pick task             |   | quota detected
                   v                       |   v
              +----------+                 | +--------------+
              | running  |                 | |waiting_quota |
              +----------+                 | | (smart wait) |
                                           | +------+-------+
                          non-quota error   |       | timer expires
                                +----------+       |
                                v                  |
                          +--------------+         |
                          |waiting_retry |         |
                          | (dumb wait)  |         |
                          +------+-------+         |
                                 |                 |
                                 +--------+--------+
                                          |
                                          v
                                    +----------+
                                    | running  | (retry)
                                    +----------+

When all tasks done:

              +--------------+
 all done --> | final_review |<---- has fix tasks
              | (round N)    |        |
              +------+-------+        |
                     |                |
              +------+-------+        |
              |              |        |
          no issues    found bugs ----+
              |        (fix -> re-review)
              v
        +-----------------+
        |final_review_done|
        +-----------------+

Max rounds reached with unresolved issues:

        +--------------+
        | final_review  |
        | (max reached) |
        +------+-------+
               | has unresolved
               v
  +--------------------------+
  | awaiting_user_decision   |
  | (autopilot paused)       |
  +-----+----------+---------+
        |          |
  --continue    --accept
   -review      -as-is
        |          |
        v          v
  +----------+ +-----------------+
  | resume   | |final_review_done|
  | review   | +-----------------+
  +----------+
```

**Key distinctions**:
- `waiting_quota` does not consume the retry budget -- rate limits are expected, not errors
- `final_review` dispatches multiple AI models in parallel for cross-validation
- The review loop converges when zero new BUG/SECURITY/COVERAGE GAP issues are found
- `awaiting_user_decision` ensures humans have final say when issues persist after max rounds

## Multi-Runtime Support

The scaffold is runtime-agnostic. Configure once, switch anytime:

```bash
pnpm autopilot:configure
```

Supported runtimes:
- **Claude CLI** -- `claude` with `--print` mode
- **Codex CLI** -- OpenAI's `codex` with `--full-auto`
- **Custom** -- any CLI that accepts a prompt on stdin and returns output on stdout

## Deploy Readiness

Run `pnpm health` for basic structure validation, or add `--deploy-ready` for production checks:

```bash
node infra/scripts/health-check.mjs --deploy-ready
```

Deploy readiness checks:
1. **Environment variables** -- production env file exists, no placeholder values
2. **Secrets scan** -- walks `src/`, `apps/`, `packages/` for hardcoded keys/tokens/passwords
3. **Build verification** -- runs `pnpm build` and checks for output directories
4. **Package.json** -- name, version, private flag, no `file:`/`link:` dependencies
5. **Legal pages** (if payment enabled) -- privacy policy, terms of service, support email

## Philosophy

1. **Let AI clarify before coding** -- the intake interview prevents wasted work
2. **Planning state belongs in the repo** -- not in a SaaS, not in a database
3. **Autonomy requires resilience** -- quota walls and crashes are expected, not exceptional
4. **Small verifiable tasks** -- every task has explicit acceptance criteria
5. **Strongest model orchestrates, fastest model implements** -- match model capability to task type

## Contributing

See [AGENTS.md](./AGENTS.md) for the repo rules that both humans and AI agents follow. The [`.ai/recipes/`](./.ai/recipes/) directory contains playbooks for common workflows.

## License

MIT
