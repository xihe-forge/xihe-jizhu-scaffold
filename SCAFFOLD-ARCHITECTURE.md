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

## Robustness Goals

- Recover after interrupted sessions
- Keep plans and code aligned
- Make work reviewable in small slices
- Support human + AI collaboration without hidden state
