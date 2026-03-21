Show a cost and token usage report from autopilot run metrics.

Read `dev/metrics.json`. If the file does not exist, tell the user to run the autopilot first (`pnpm work`) so that metrics are collected, then stop.

## Summary Table (always shown)

Compute the following across **all sessions** in the file:

- Total sessions
- Total task invocations (all statuses)
- Total successful tasks (status === "success")
- Total input tokens
- Total output tokens
- Total tokens (input + output)
- Total cost USD (formatted to 6 decimal places)
- Average cost per successful task (total_cost_usd / tasks_completed, or "n/a" if zero)
- Most expensive single task invocation (task_id, session_id, cost_usd)

Present as a Markdown table:

| Metric | Value |
|--------|-------|
| Sessions | N |
| Task invocations | N |
| Tasks completed (success) | N |
| Total input tokens | N |
| Total output tokens | N |
| Total tokens | N |
| Total cost | $X.XXXXXX |
| Avg cost / task | $X.XXXXXX |
| Most expensive task | TASK_ID ($X.XX) |

## Detail Mode (only when $ARGUMENTS === "detail")

If the user passed `detail` as the argument, also show a per-session breakdown table after the summary:

For each session (most recent first, sorted by `started_at` descending):

### Session `<session_id>` — started `<started_at>`

| Task ID | Model | Status | Duration | Input Tokens | Output Tokens | Cost USD |
|---------|-------|--------|----------|-------------|--------------|---------|
| ... | ... | ... | Xs | N | N | $X.XXXXXX |

Then a session totals row:
| **TOTAL** | | | Xs | N | N | $X.XXXXXX |

Format durations as seconds (e.g. `42s`) for values under 60 s, or `Xm Ys` for longer values.
Format costs always with 6 decimal places (e.g. `$0.012500`).
