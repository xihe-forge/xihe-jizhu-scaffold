# Scaffold Architecture

## Layer 1: Engineering Base

This scaffold uses a monorepo layout:

- `apps/`
- `packages/`
- `docs/`
- `dev/`
- `test/`
- `infra/`

## Layer 2: Durable Planning State

The `.planning/` directory captures state that survives session resets:

- `PROJECT.md`
- `REQUIREMENTS.md`
- `ROADMAP.md`
- `STATE.md`
- `config.json`
- `phases/`

## Layer 3: Execution Governance

The `.ai/` directory is runtime-agnostic and stores:

- recipes
- templates
- agent notes
- hook notes
- `.ai/skills/` -- skill modules (impeccable, vercel-web-design, xihe-search-forge) and the skill registry (`skill-registry.json`)

## Layer 4: Runtime Bridges

External AI CLI integrations for multi-runtime delegation:

- `codex-bridge/` -- PowerShell module for delegating tasks to OpenAI Codex CLI
- `gemini-bridge/` -- PowerShell module for delegating tasks to Google Gemini CLI

These are invoked by the autopilot orchestrator when a task's `assignee` is `"codex"` or `"gemini"`.

## Robustness Goals

- Recover after interrupted sessions
- Keep plans and code aligned
- Make work reviewable in small slices
- Support human + AI collaboration without hidden state
