# Intake State

This directory stores durable kickoff state while the AI is still interviewing the user and generating the initial plan.

Tracked files:

- `README.md`: explains the purpose of this directory

Runtime-only files:

- `state.json`: resumable kickoff state

If kickoff is interrupted by quota, rate limits, or a closed terminal, run `pnpm kickoff` again and it will resume from `state.json`.
Quota waits do not consume the normal non-quota retry budget, so long reset windows will keep waiting instead of failing fast.
