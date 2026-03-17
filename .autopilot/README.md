# Autopilot

This directory powers the continuous work mode.

Tracked files:

- `config.json`: behavior and runtime settings, including `Claude`, `Codex`, and `custom` runner profiles

Runtime-only files:

- `state.json`: current session state
- `.stop`: stop signal
- `logs/`: runtime logs

The default flow is:

1. read `.planning/` and `dev/task.json`
2. pick the next runnable task
3. start or resume the configured AI session
4. update state and retry if interrupted

Use `pnpm autopilot:configure` to switch runtimes without editing JSON by hand.

If the runner hits quota or rate limits, autopilot records that state and waits before retrying.
