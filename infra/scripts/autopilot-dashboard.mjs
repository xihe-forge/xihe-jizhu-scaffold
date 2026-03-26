import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { rootDir, resolvePath, readJson, readText } from "./lib/utils.mjs";

function lastLines(text, n) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-n);
}

// ─── Data gathering ──────────────────────────────────────────────────────────

function gatherData() {
  const metrics = readJson("dev/metrics.json", { sessions: [] });
  const state = readJson(".autopilot/state.json", null);
  const tasks = readJson("dev/task.json", { tasks: [] });
  const progress = readText("dev/progress.txt");
  const notifLog = readText(".autopilot/logs/notifications.log");
  const planConfig = readJson(".planning/config.json", {});

  const allTasks = tasks?.tasks ?? [];
  const done = allTasks.filter((t) => t.status === "done").length;
  const inProgress = allTasks.filter((t) => t.status === "in_progress").length;
  const blocked = allTasks.filter((t) => t.status === "blocked").length;
  const todo = allTasks.filter((t) => t.status === "todo").length;
  const total = allTasks.length;

  // Aggregate session data
  const sessions = metrics?.sessions ?? [];
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalDurationMs = 0;
  let totalTasksCompleted = 0;
  const modelUsage = {};

  for (const session of sessions) {
    const totals = session.totals ?? {};
    totalCost += totals.total_cost_usd ?? 0;
    totalInputTokens += totals.total_input_tokens ?? 0;
    totalOutputTokens += totals.total_output_tokens ?? 0;
    totalDurationMs += totals.total_duration_ms ?? 0;
    totalTasksCompleted += totals.tasks_completed ?? 0;

    for (const task of session.tasks ?? []) {
      const model = task.model ?? "unknown";
      if (!modelUsage[model]) {
        modelUsage[model] = { tasks: 0, cost: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
      }
      modelUsage[model].tasks += 1;
      modelUsage[model].cost += task.cost_usd ?? 0;
      modelUsage[model].inputTokens += task.input_tokens ?? 0;
      modelUsage[model].outputTokens += task.output_tokens ?? 0;
      modelUsage[model].durationMs += task.duration_ms ?? 0;
    }
  }

  // Recent notification events (last 20)
  const recentEvents = lastLines(notifLog, 20);

  // Recent progress (last 10)
  const recentProgress = lastLines(progress, 10);

  // Uptime calculation
  let uptimeText = "N/A";
  if (sessions.length > 0) {
    const firstStarted = sessions[0]?.started_at;
    if (firstStarted) {
      const startTime = new Date(firstStarted).getTime();
      const elapsedMs = Date.now() - startTime;
      const hours = Math.floor(elapsedMs / 3600000);
      const minutes = Math.floor((elapsedMs % 3600000) / 60000);
      uptimeText = `${hours}h ${minutes}m`;
    }
  }

  return {
    state,
    taskCounts: { done, inProgress, blocked, todo, total },
    cost: { total: totalCost, avgPerTask: totalTasksCompleted > 0 ? totalCost / totalTasksCompleted : 0 },
    tokens: { input: totalInputTokens, output: totalOutputTokens },
    totalDurationMs,
    totalTasksCompleted,
    sessions,
    modelUsage,
    recentEvents,
    recentProgress,
    uptimeText,
    projectName: planConfig?.project_name ?? path.basename(rootDir)
  };
}

// ─── HTML generation ─────────────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatCost(usd) {
  return `$${usd.toFixed(4)}`;
}

function formatNumber(n) {
  return n.toLocaleString("en-US");
}

function statusColor(status) {
  if (!status) return "#888";
  if (status === "running" || status === "done" || status === "success" || status === "final_review_done") return "#22c55e";
  if (status === "quota_wait" || status === "waiting_quota" || status === "waiting_retry" || status === "in_progress") return "#eab308";
  if (status === "error" || status === "failed") return "#ef4444";
  if (status === "awaiting_user_decision") return "#f97316";
  return "#60a5fa";
}

function generateHtml(data) {
  const { state, taskCounts, cost, tokens, totalDurationMs, sessions, modelUsage, recentEvents, recentProgress, uptimeText, projectName } = data;
  const currentStatus = state?.status ?? "not started";
  const currentTask = state?.lastTaskId ?? "none";
  const currentRound = state?.round ?? 0;
  const generatedAt = new Date().toISOString();

  // Task bar widths (percentage)
  const total = Math.max(1, taskCounts.total);
  const donePct = (taskCounts.done / total * 100).toFixed(1);
  const inProgressPct = (taskCounts.inProgress / total * 100).toFixed(1);
  const todoPct = (taskCounts.todo / total * 100).toFixed(1);
  const blockedPct = (taskCounts.blocked / total * 100).toFixed(1);

  // Session timeline rows
  const sessionRows = sessions.map((s, idx) => {
    const taskCount = (s.tasks ?? []).length;
    const sessionCost = s.totals?.total_cost_usd ?? 0;
    const sessionDuration = s.totals?.total_duration_ms ?? 0;
    const sessionCompleted = s.totals?.tasks_completed ?? 0;
    return `<tr>
      <td>${idx + 1}</td>
      <td>${escapeHtml(s.session_id?.slice(0, 8) ?? "?")}</td>
      <td>${escapeHtml(s.started_at ?? "?")}</td>
      <td>${taskCount}</td>
      <td>${sessionCompleted}</td>
      <td>${formatCost(sessionCost)}</td>
      <td>${formatDuration(sessionDuration)}</td>
    </tr>`;
  }).join("\n");

  // Model usage rows
  const modelRows = Object.entries(modelUsage).map(([model, usage]) => {
    return `<tr>
      <td>${escapeHtml(model)}</td>
      <td>${usage.tasks}</td>
      <td>${formatNumber(usage.inputTokens)}</td>
      <td>${formatNumber(usage.outputTokens)}</td>
      <td>${formatCost(usage.cost)}</td>
      <td>${formatDuration(usage.durationMs)}</td>
    </tr>`;
  }).join("\n");

  // Recent events rows
  const eventRows = recentEvents.map((line) => {
    return `<tr><td class="log-line">${escapeHtml(line)}</td></tr>`;
  }).join("\n");

  // Recent progress rows
  const progressRows = recentProgress.map((line) => {
    return `<tr><td class="log-line">${escapeHtml(line)}</td></tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Autopilot Dashboard — ${escapeHtml(projectName)}</title>
<style>
  :root {
    --bg: #0f172a;
    --surface: #1e293b;
    --border: #334155;
    --text: #e2e8f0;
    --text-muted: #94a3b8;
    --accent: #60a5fa;
    --green: #22c55e;
    --yellow: #eab308;
    --red: #ef4444;
    --orange: #f97316;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 24px;
    line-height: 1.6;
  }
  h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 12px; color: var(--accent); }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .header-right { text-align: right; color: var(--text-muted); font-size: 0.85rem; }
  .status-badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 0.85rem;
    font-weight: 600;
    color: #000;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }
  .stat-row { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .stat-label { color: var(--text-muted); }
  .stat-value { font-weight: 600; font-variant-numeric: tabular-nums; }
  .bar-container {
    width: 100%;
    height: 24px;
    background: var(--bg);
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    margin: 8px 0;
  }
  .bar-done { background: var(--green); height: 100%; }
  .bar-inprog { background: var(--yellow); height: 100%; }
  .bar-todo { background: var(--accent); height: 100%; }
  .bar-blocked { background: var(--red); height: 100%; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; font-size: 0.85rem; }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--text-muted); font-weight: 600; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }
  .log-line { font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace; font-size: 0.8rem; white-space: pre-wrap; word-break: break-all; }
  .full-width { grid-column: 1 / -1; }
  .footer { margin-top: 24px; text-align: center; color: var(--text-muted); font-size: 0.8rem; }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>${escapeHtml(projectName)} — Autopilot Dashboard</h1>
    <span>Round ${currentRound} &middot; Task: ${escapeHtml(currentTask)}</span>
  </div>
  <div class="header-right">
    <div>
      Status: <span class="status-badge" style="background: ${statusColor(currentStatus)}">${escapeHtml(currentStatus)}</span>
    </div>
    <div>Uptime: ${escapeHtml(uptimeText)}</div>
    <div>Generated: ${escapeHtml(generatedAt)}</div>
  </div>
</div>

<div class="grid">
  <!-- Task Progress -->
  <div class="card">
    <h2>Task Progress</h2>
    <div class="bar-container">
      <div class="bar-done" style="width: ${donePct}%"></div>
      <div class="bar-inprog" style="width: ${inProgressPct}%"></div>
      <div class="bar-todo" style="width: ${todoPct}%"></div>
      <div class="bar-blocked" style="width: ${blockedPct}%"></div>
    </div>
    <div class="legend">
      <span class="legend-item"><span class="legend-dot" style="background: var(--green)"></span> Done (${taskCounts.done})</span>
      <span class="legend-item"><span class="legend-dot" style="background: var(--yellow)"></span> In Progress (${taskCounts.inProgress})</span>
      <span class="legend-item"><span class="legend-dot" style="background: var(--accent)"></span> Todo (${taskCounts.todo})</span>
      <span class="legend-item"><span class="legend-dot" style="background: var(--red)"></span> Blocked (${taskCounts.blocked})</span>
    </div>
    <div class="stat-row" style="margin-top: 12px;">
      <span class="stat-label">Total tasks</span>
      <span class="stat-value">${taskCounts.total}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Completion</span>
      <span class="stat-value">${taskCounts.total > 0 ? (taskCounts.done / taskCounts.total * 100).toFixed(0) : 0}%</span>
    </div>
  </div>

  <!-- Cost Summary -->
  <div class="card">
    <h2>Cost Summary</h2>
    <div class="stat-row">
      <span class="stat-label">Total cost</span>
      <span class="stat-value">${formatCost(cost.total)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Avg cost per task</span>
      <span class="stat-value">${formatCost(cost.avgPerTask)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Input tokens</span>
      <span class="stat-value">${formatNumber(tokens.input)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Output tokens</span>
      <span class="stat-value">${formatNumber(tokens.output)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Total runtime</span>
      <span class="stat-value">${formatDuration(totalDurationMs)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Sessions</span>
      <span class="stat-value">${sessions.length}</span>
    </div>
  </div>
</div>

<!-- Model Usage -->
<div class="grid">
  <div class="card full-width">
    <h2>Model Usage</h2>
    <table>
      <thead>
        <tr><th>Model</th><th>Tasks</th><th>Input Tokens</th><th>Output Tokens</th><th>Cost</th><th>Duration</th></tr>
      </thead>
      <tbody>
        ${modelRows || '<tr><td colspan="6" style="color: var(--text-muted)">(no model data yet)</td></tr>'}
      </tbody>
    </table>
  </div>
</div>

<!-- Session Timeline -->
<div class="grid">
  <div class="card full-width">
    <h2>Session Timeline</h2>
    <table>
      <thead>
        <tr><th>#</th><th>Session</th><th>Started</th><th>Invocations</th><th>Completed</th><th>Cost</th><th>Duration</th></tr>
      </thead>
      <tbody>
        ${sessionRows || '<tr><td colspan="7" style="color: var(--text-muted)">(no sessions yet)</td></tr>'}
      </tbody>
    </table>
  </div>
</div>

<!-- Recent Events & Progress -->
<div class="grid">
  <div class="card">
    <h2>Recent Events</h2>
    <table>
      <tbody>
        ${eventRows || '<tr><td class="log-line" style="color: var(--text-muted)">(no notification events yet)</td></tr>'}
      </tbody>
    </table>
  </div>
  <div class="card">
    <h2>Recent Progress</h2>
    <table>
      <tbody>
        ${progressRows || '<tr><td class="log-line" style="color: var(--text-muted)">(no progress entries yet)</td></tr>'}
      </tbody>
    </table>
  </div>
</div>

<div class="footer">
  Autopilot Dashboard &middot; Generated by xihe-jizhu-scaffold
</div>

</body>
</html>`;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function main() {
  const data = gatherData();
  const html = generateHtml(data);

  const reportDir = resolvePath("dev/reports");
  mkdirSync(reportDir, { recursive: true });

  const outputPath = resolvePath("dev/reports/dashboard.html");
  writeFileSync(outputPath, html, "utf8");
  console.log(`Dashboard written to: ${outputPath}`);

  // Try to open in browser
  try {
    let result;
    if (process.platform === "win32") {
      // Use cmd /c start with argument array to avoid shell injection
      result = spawnSync("cmd.exe", ["/c", "start", "", outputPath], { stdio: "ignore", shell: false });
    } else if (process.platform === "darwin") {
      result = spawnSync("open", [outputPath], { stdio: "ignore", shell: false });
    } else {
      result = spawnSync("xdg-open", [outputPath], { stdio: "ignore", shell: false });
    }
    if (result && result.status === 0) {
      console.log("Opened dashboard in default browser.");
    } else {
      console.log("Could not auto-open browser. Open the file manually.");
    }
  } catch {
    console.log("Could not auto-open browser. Open the file manually.");
  }
}

main();
