Start the autopilot continuous delivery loop.

Execute the following command:

```bash
node infra/scripts/autopilot-start.mjs $ARGUMENTS
```

Supported flags:
- `--dry-run` — show prompts without executing
- `--once` — run one cycle then stop
- `--continue-review` — resume from `awaiting_user_decision` and add more review rounds
- `--accept-as-is` — resume from `awaiting_user_decision` and accept current state

The autopilot will:
1. Pick the next ready task from `dev/task.json`
2. Build a prompt and dispatch to the configured runner (Claude/Codex/Gemini)
3. Update task status and progress
4. Loop until all tasks are done, then enter final review phase
