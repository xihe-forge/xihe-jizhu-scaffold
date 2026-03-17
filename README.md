# Robust AI Scaffold

A production-grade scaffold for **autonomous AI software development** — combining durable planning state, 24/7 autopilot execution, and intelligent quota self-healing.

Built for teams that want AI agents to ship code continuously, not just respond to prompts.

## What This Does

You describe a project idea. The scaffold:

1. **Interviews** you to clarify scope, requirements, and priorities
2. **Generates** a structured project plan (tasks, milestones, acceptance criteria)
3. **Executes autonomously** using a two-tier agent model (Opus orchestrates, Sonnet implements)
4. **Survives interruptions** — quota exhaustion, rate limits, process crashes — and resumes where it left off

The result is a self-governing development loop that runs until the work is done.

## Key Design Decisions

### Two-Tier Agent Model (Opus + Sonnet)

The autopilot always runs the strongest model (Opus) as orchestrator. Opus reads the task queue, analyzes dependencies, plans decomposition, and dispatches Sonnet sub-agents for implementation. Every coding agent runs in **worktree isolation** — its own git branch and working directory — so parallel agents never conflict.

This is not just a cost optimization. The orchestrator needs persistent project memory (what's done, what's blocked, what decisions were made). Workers need fresh context focused on a single task. The two-tier split matches these fundamentally different context requirements.

### Quota Self-Healing

When the AI runtime hits rate limits or quota exhaustion, most tools crash or burn retries. This scaffold recognizes quota failures as a distinct category — they don't consume the normal retry budget. The autopilot enters a `waiting_quota` state, parses reset times when available, and resumes automatically. A 24-hour run that hits 5 quota walls still completes all tasks.

### Durable Planning State

All planning artifacts live in `.planning/` as plain files:

| File | Purpose |
|------|---------|
| `PROJECT.md` | Identity, positioning, target users |
| `REQUIREMENTS.md` | In-scope, out-of-scope, constraints |
| `ROADMAP.md` | Milestones and phase sequence |
| `STATE.md` | Current status, blockers, next step, decisions |

The AI reads these before every round. Humans can edit them directly. There's no database, no server, no lock-in — just files in your repo.

### Additive-Only Project Adoption

Got an existing project? `pnpm adopt` overlays the planning layer without touching your source code, configs, or project structure. It scans your repo, interviews you about goals, and generates the planning files. Existing files are never overwritten.

## Architecture

```
robust-ai-scaffold/
├── .planning/          # Durable planning state (PROJECT, REQUIREMENTS, ROADMAP, STATE)
├── .ai/recipes/        # Agent playbooks (implement, review, diagnose, adopt)
├── .autopilot/         # Runtime config (model selection, retry policy)
├── apps/               # Application entrypoints
├── packages/           # Shared code and types
├── docs/               # Research, MRD, PRD, tech specs, design docs
├── dev/                # task.json, progress.txt, bug fixes, review logs
├── test/               # Unit, integration, e2e tests
├── infra/scripts/      # Autopilot engine, intake flow, health checks
├── AGENTS.md           # Agent behavior rules (read before every round)
└── package.json        # All commands: kickoff, work, adopt, health, etc.
```

## Quick Start

### New Project

```bash
git clone https://github.com/47Liu/robust-ai-scaffold.git my-project
cd my-project
pnpm install
pnpm kickoff
```

The intake flow will:
- Ask you to describe your project idea
- Generate structured planning files and task queue
- Configure your AI runtime (Claude Code, Codex CLI, or custom)
- Optionally start the autopilot immediately

### Adopt Existing Project

```bash
cd your-existing-project
npx robust-ai-scaffold adopt
# or copy the scaffold and run:
pnpm adopt
```

### Start Autonomous Work

```bash
pnpm work
```

The autopilot will:
- Read `AGENTS.md` and `.planning/STATE.md`
- Pick the highest-priority task with all dependencies satisfied
- Dispatch parallel sub-agents when multiple tasks are ready
- Review, merge, and verify before marking tasks complete
- Handle quota/rate limits automatically
- Loop until all tasks are done

### Other Commands

```bash
pnpm start-here          # Interactive menu
pnpm health              # Validate project structure
pnpm plan:status         # Show planning state
pnpm autopilot:status    # Show autopilot status
pnpm autopilot:configure # Change AI runtime
pnpm autopilot:stop      # Stop the autopilot
```

## How It Compares

| Capability | robust-ai-scaffold | superpowers | get-shit-done | workflows |
|---|---|---|---|---|
| Autonomous loop | Yes (24/7 with quota self-healing) | No (single session) | No (single session) | No (single session) |
| Project scaffolding | Yes (intake interview → full project) | No | No | No |
| Adopt existing project | Yes (additive overlay) | No | No | No |
| Multi-runtime support | Claude Code, Codex CLI, Custom | Claude Code only | Claude Code only | Claude Code only |
| Parallel agent execution | Yes (worktree isolation) | Yes (worktree) | Yes (wave execution) | Yes (orchestrator pattern) |
| Model hierarchy | Opus orchestrator + Sonnet workers | Single model | Model profiles (quality/balanced/budget) | Single model |
| Quota/rate limit recovery | Dedicated state machine | No | No | No |
| Process resume after crash | Yes (durable state files) | No | No | No |
| Quality gates | Review recipes + verification | Hard gates + rationalization blockers | Nyquist validation + deviation rules | 5-phase quality fixer |
| Task dependency graph | Yes (depends_on with ready detection) | Manual ordering | DAG with wave grouping | Scale-based dispatch |

**Our unique position**: the only scaffold that combines project creation, autonomous execution, and production resilience (quota handling, crash recovery, concurrent safety) in a single tool. Others optimize for single-session quality; we optimize for **continuous autonomous delivery**.

## Multi-Runtime Support

The scaffold is runtime-agnostic. Configure once, switch anytime:

```bash
pnpm autopilot:configure
```

Supported runtimes:
- **Claude Code** — `claude` CLI with `--print` mode
- **Codex CLI** — OpenAI's `codex` with `--full-auto`
- **Custom** — any CLI that accepts a prompt on stdin and returns output on stdout

## Philosophy

1. **Let AI clarify before coding** — the intake interview prevents wasted work
2. **Planning state belongs in the repo** — not in a SaaS, not in a database
3. **Autonomy requires resilience** — quota walls and crashes are expected, not exceptional
4. **Small verifiable tasks** — every task has explicit acceptance criteria
5. **Strongest model orchestrates, fastest model implements** — match model capability to task type

## Contributing

See [AGENTS.md](./AGENTS.md) for the repo rules that both humans and AI agents follow. The [`.ai/recipes/`](./.ai/recipes/) directory contains playbooks for common workflows.

## License

MIT
