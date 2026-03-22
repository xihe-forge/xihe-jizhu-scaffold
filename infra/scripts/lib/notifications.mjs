import { appendFileSync } from "node:fs";
import { ensureDir, readJson, resolvePath } from "./utils.mjs";

// ─── Default notification configuration ─────────────────────────────────────

const DEFAULT_NOTIFICATION_CONFIG = {
  enabled: false,
  webhook_url: null,
  events: {
    task_completed: true,
    task_failed: true,
    quota_wait: true,
    all_tasks_done: true,
    final_review_started: true,
    final_review_done: true,
    awaiting_user_decision: true,
    error: true,
    stopped: true
  }
};

// ─── Configuration ──────────────────────────────────────────────────────────

/** Lazy singleton — loaded once on first use. */
let _cachedConfig = null;

/**
 * Load notification settings from `.autopilot/config.json` under the
 * `notifications` key.  Returns the merged config (defaults + overrides).
 * Result is cached after the first call.
 */
/** Reset the cached config (for testing only). */
export function resetNotificationCache() {
  _cachedConfig = null;
}

export function loadNotificationConfig() {
  if (_cachedConfig !== null) return _cachedConfig;
  const raw = readJson(".autopilot/config.json", {});
  const userConfig = raw?.notifications ?? {};
  _cachedConfig = {
    ...DEFAULT_NOTIFICATION_CONFIG,
    ...userConfig,
    events: {
      ...DEFAULT_NOTIFICATION_CONFIG.events,
      ...(userConfig.events ?? {})
    }
  };
  return _cachedConfig;
}

// ─── Log helpers ─────────────────────────────────────────────────────────────

function formatLogLine(event, details) {
  const timestamp = new Date().toISOString();
  const detailStr = typeof details === "string"
    ? details
    : JSON.stringify(details ?? {});
  return `[${timestamp}] [${event}] ${detailStr}\n`;
}

function appendNotificationLog(line) {
  try {
    ensureDir(".autopilot/logs");
    appendFileSync(resolvePath(".autopilot/logs/notifications.log"), line, "utf8");
  } catch {
    // Non-fatal: never crash autopilot because of a log write failure
  }
}

// ─── Webhook delivery ────────────────────────────────────────────────────────

function postWebhook(url, payload) {
  // Fire-and-forget fetch — errors are swallowed
  try {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000)
    }).catch(() => {
      // swallow — notifications must never block or crash the autopilot
    });
  } catch {
    // swallow
  }
}

// ─── Core notify function ────────────────────────────────────────────────────

/**
 * Send a notification for the given event.
 *
 * - Always appends to `.autopilot/logs/notifications.log`.
 * - If a `webhook_url` is configured, POSTs JSON (non-blocking, fire-and-forget).
 *
 * @param {string} event   - Event name (e.g. "task_completed")
 * @param {object} details - Arbitrary details to include
 * @returns {Promise<void>}
 */
export async function notify(event, details = {}) {
  const config = loadNotificationConfig();

  // Always log regardless of enabled flag
  appendNotificationLog(formatLogLine(event, details));

  if (!config.enabled) {
    return;
  }

  // Check if this specific event type is enabled (falsy = disabled)
  if (!config.events[event]) {
    return;
  }

  // Webhook delivery (non-blocking)
  if (config.webhook_url) {
    postWebhook(config.webhook_url, {
      event,
      timestamp: new Date().toISOString(),
      details
    });
  }
}

// ─── State transition helper ─────────────────────────────────────────────────

/**
 * Map from new state status values to notification event names.
 * Only statuses that map to a supported event are included.
 */
const STATE_TO_EVENT = {
  waiting_quota: "quota_wait",
  error: "error",
  stopped: "stopped",
  final_review: "final_review_started",
  final_review_done: "final_review_done",
  awaiting_user_decision: "awaiting_user_decision"
};

/**
 * Compare old and new autopilot state, determine the event type,
 * and fire a notification if the event is enabled.
 *
 * @param {object} oldState - Previous state object
 * @param {object} newState - Next state object
 * @param {object} context  - Extra context (task info, round number, etc.)
 */
export function notifyStateChange(oldState, newState, context = {}) {
  const oldStatus = oldState?.status ?? "idle";
  const newStatus = newState?.status ?? "idle";

  // No transition → nothing to notify
  if (oldStatus === newStatus) {
    return;
  }

  const event = STATE_TO_EVENT[newStatus];
  if (!event) {
    return;
  }

  const details = {
    old_status: oldStatus,
    new_status: newStatus,
    ...context
  };

  // Add event-specific context
  if (event === "quota_wait") {
    details.retry_after_seconds = newState.retryAfterSeconds ?? null;
    details.quota_type = newState.lastFailureCategory ?? "unknown";
  }

  if (event === "final_review_started") {
    details.round_number = newState.finalReviewRound ?? 1;
  }

  if (event === "final_review_done") {
    details.rounds_taken = newState.finalReviewRound ?? 0;
  }

  if (event === "awaiting_user_decision") {
    details.options = [
      "pnpm work --continue-review",
      "pnpm work --accept-as-is"
    ];
  }

  if (event === "error") {
    details.error_message = newState.lastError ?? newState.lastFailureHint ?? "";
  }

  if (event === "stopped") {
    details.reason = newState.lastFailureHint ?? "user interrupted";
  }

  // Non-blocking notify — attach .catch() to handle the returned Promise
  notify(event, details).catch((err) => {
    appendNotificationLog(formatLogLine("notify_error", `Failed to notify ${event}: ${err?.message ?? err}`));
  });
}
