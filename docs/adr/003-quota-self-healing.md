# ADR-003: Quota Self-Healing State Machine

## Status
Accepted

## Context
AI API providers impose rate limits and usage quotas. When exhausted:
- Claude Code exits with an error message mentioning "rate limit" or "429"
- Codex CLI exits with similar error
- Quota typically resets on a time schedule (hourly, daily)

For a 24/7 autopilot, quota exhaustion is **expected**, not exceptional. A single overnight run may hit quota 3-5 times. If each hit burns a retry and eventually stops, the autopilot can't sustain continuous operation.

No competing project handles this — superpowers, GSD, and workflows all assume single-session operation.

## Decision
Implement a dedicated state machine for the autopilot loop:

```
idle → running → waiting_quota → running (resume)
                → waiting_retry → running (retry)
                → stopped (user signal)
                → error (max retries exceeded)
```

Key rules:
1. **Quota failures are a distinct category** — they do NOT increment the normal retry counter
2. **Parse reset times** from error messages when available (e.g., "resets 2:00 AM")
3. **Wait intelligently** — use parsed reset time, or configurable fallback (default 30 min)
4. **Resume session** — after quota recovery, resume the same AI session to preserve context

## Consequences

### Positive
- Autopilot survives unlimited quota hits without stopping
- Intelligent wait times minimize idle periods
- Retry budget is preserved for real failures (bugs, crashes)
- Session continuity across quota waits

### Negative
- Quota detection relies on parsing error messages (fragile)
- Reset time parsing only works for specific message formats
- If API error format changes, detection may break silently

### Mitigations
- T004 (structured error parsing) will add JSON error parsing as primary detection
- Text-based fallback retained as safety net
- Stale lock detection prevents permanent hang after crash during wait
