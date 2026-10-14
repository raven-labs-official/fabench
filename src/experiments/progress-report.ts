/** Build and optionally send the shared FABench progress report to Feishu. */
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { ExperimentRegistry, type RegistryRunRow } from "./registry.js";
import { SHARED_BENCH_DIR, SHARED_ROOT, SHARED_RUNS_ROOT, SITE_NAME } from "../path-config.js";
import { projectEnv } from "../env-names.js";

const REPORT_TIME_ZONE = projectEnv("FABENCH_PROGRESS_TIME_ZONE")?.trim() || "Asia/Shanghai";
const DEFAULT_ARCHIVE_DIR = existsSync(SHARED_RUNS_ROOT)
  ? join(SHARED_BENCH_DIR, "progress-reports")
  : "results/progress-reports";

export interface ProgressEstimate {
  terminalCells: number;
  progressPercent: number;
  elapsedMs: number;
  remainingMs: number | null;
  totalMs: number | null;
  etaUtc: string | null;
}

export interface UnregisteredExperiment {
  owner: string;
  pid: number;
  parentPid: number;
  elapsedSeconds: number;
  name: string;
  parameters: string;
  note: string;
}

interface ProcessRow {
  owner: string;
  pid: number;
  parentPid: number;
  elapsedSeconds: number;
  args: string;
}

export interface ProgressSnapshot {
  generatedAtUtc: string;
  timeZone: string;
  host: string;
  load1: number;
  memoryAvailableBytes: number;
  memoryTotalBytes: number;
  dataDiskAvailableBytes: number | null;
  registeredRuns: RegistryRunRow[];
  unregisteredExperiments: UnregisteredExperiment[];
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function estimateProgress(run: RegistryRunRow, nowMs = Date.now()): ProgressEstimate {
  const terminalCells = Math.min(
    run.expectedCells,
    run.reusedCells + run.succeededCells + run.failedCells + run.interruptedCells,
  );
  const observedUntil=run.status==='stale'?Date.parse(run.lastHeartbeatUtc):run.finishedAtUtc?Date.parse(run.finishedAtUtc):nowMs;
  const elapsedMs = Math.max(0, observedUntil - Date.parse(run.startedAtUtc));
  const newlyProcessed = run.succeededCells + run.failedCells + run.interruptedCells;
  const newWorkTotal = Math.max(0, run.expectedCells - run.reusedCells);
  const remainingNewWork = Math.max(0, newWorkTotal - newlyProcessed);
  const hasRate = run.status==='running' && elapsedMs > 0 && newlyProcessed > 0;
  const remainingMs = remainingNewWork === 0
    ? 0
    : hasRate
      ? elapsedMs * remainingNewWork / newlyProcessed
      : null;
  return {
    terminalCells,
    progressPercent: run.expectedCells > 0 ? terminalCells / run.expectedCells * 100 : 0,
    elapsedMs,
    remainingMs,
    totalMs: remainingMs === null ? null : elapsedMs + remainingMs,
    etaUtc: remainingMs === null ? null : new Date(nowMs + remainingMs).toISOString(),
  };
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "no estimate yet";
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor(totalMinutes % 1440 / 60);
  const minutes = totalMinutes % 60;
  return [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    minutes || (!days && !hours) ? `${minutes}m` : "",
  ].filter(Boolean).join(" ");
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib.toFixed(gib >= 10 ? 0 : 1)}GB`;
}

function formatLocalTime(isoOrMs: string | number): string {
  const date = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: REPORT_TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date).replaceAll("/", "-");
}

function listValue(value: unknown): string | null {
  if (Array.isArray(value)) return value.map(String).join(",");
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function configSummary(run: RegistryRunRow): string {
  const config = run.config;
  if (!config) return "config damaged; cannot read the run conditions";
  const conditions = Array.isArray(config.conditions)
    ? config.conditions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  const arms = listValue(config.compare)
    ?? [...new Set(conditions.map((item) => String(item.search_type ?? item.arm ?? "")).filter(Boolean))].join(",");
  const questionCount = Array.isArray(config.selected_question_ids)
    ? config.selected_question_ids.length
    : conditions.length
      ? Math.round(run.expectedCells / conditions.length)
      : null;
  const reasoningMode = listValue(config.reasoning_mode) ?? "empty/provider-default";
  const thinkingEffort = listValue(config.thinking_effort)
    ?? listValue(config.requested_thinking_effort)
    ?? "empty/provider-default";
  const pieces = [
    `model ${String(config.llm ?? "unknown")}`,
    arms ? `arms ${arms}` : "",
    questionCount ? `questions ${questionCount}` : "",
    finiteNumber(config.conc) !== null ? `conc ${finiteNumber(config.conc)}` : "",
    finiteNumber(config.maxToolCalls) !== null ? `max-tool ${finiteNumber(config.maxToolCalls)}` : "",
    finiteNumber(config.maxResultsPerSearch) !== null
      ? `results per search ${finiteNumber(config.maxResultsPerSearch)}`
      : "",
    `reasoning ${reasoningMode}`,
    `effort ${thinkingEffort}`,
  ];
  return pieces.filter(Boolean).join(" | ");
}

function runNotes(run: RegistryRunRow): string {
  const notes: string[] = [];
  if (run.configError) notes.push("run config damaged; check the original record");
  if (run.reusedCells) notes.push(`reused ${run.reusedCells}`);
  if (run.failedCells) {
    const failureRate = run.expectedCells > 0 ? run.failedCells / run.expectedCells * 100 : 0;
    notes.push(`failed ${run.failedCells} (${failureRate.toFixed(1)}%)`);
  }
  if (run.interruptedCells) notes.push(`interrupted ${run.interruptedCells}`);
  if (run.status === "stale") notes.push("heartbeat or process check failed; needs a manual check");
  if (run.claimedCells) notes.push(`not yet terminal ${run.claimedCells}`);
  return notes.join("; ") || "no issues";
}

function friendlyModel(run: RegistryRunRow): string {
  if (!run.config) return "config unavailable";
  const raw = String(run.config.llm ?? run.tag).replace(/^[^:]+:/, "");
  const known: Record<string, string> = {
    "deepseek-v4-pro": "DeepSeek V4 Pro",
    "deepseek-v4-flash": "DeepSeek V4 Flash",
    "glm-5.2": "GLM-5.2",
    "glm-4.7-flash": "GLM-4.7 Flash",
    "k3": "Kimi K3",
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-6-sol": "GPT-6 Sol",
    "claude-opus-5-5": "Claude Opus 5.5",
  };
  return known[raw] ?? raw;
}

function escapeLarkMarkdown(value: string, maxLength = 160): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const truncated = compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
  return truncated
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\*_`\[\]])/g, "\\$1");
}

function cardText(content: string): Record<string, unknown> {
  return { tag: "div", text: { tag: "lark_md", content } };
}

function cardTableRow(
  cells: Array<{ content: string; weight: number }>,
  header = false,
  shaded = false,
): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    ...(header || shaded ? { background_style: "grey" } : {}),
    columns: cells.map((cell) => ({
      tag: "column",
      width: "weighted",
      weight: cell.weight,
      vertical_align: "center",
      elements: [cardText(header ? `**${cell.content}**` : cell.content)],
    })),
  };
}

function processRows(): ProcessRow[] {
  let output = "";
  try {
    output = execFileSync("ps", ["-eo", "user=,pid=,ppid=,etimes=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  return output.split("\n").flatMap((line): ProcessRow[] => {
    const match = line.match(/^\s*(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    return [{
      owner: match[1]!,
      pid: Number(match[2]),
      parentPid: Number(match[3]),
      elapsedSeconds: Number(match[4]),
      args: match[5]!,
    }];
  });
}

function option(args: string, name: string): string | null {
  const escaped = name.replaceAll("-", "\\-");
  return args.match(new RegExp(`(?:^|\\s)--${escaped}(?:=|\\s+)("[^"]+"|'[^']+'|\\S+)`))?.[1]
    ?.replace(/^['"]|['"]$/g, "") ?? null;
}

function unmanagedName(row: ProcessRow): string | null {
  const tag = option(row.args, "tag");
  if (tag) return tag;
  if (/kimi_driver\.sh/.test(row.args)) return "Kimi auto-continuation driver";
  if (/futurex-replay\.ts/.test(row.args)) return "FutureX replay (unregistered)";
  if (/run-codex-frozen-probe\.mjs/.test(row.args)) return "Codex frozen probe (unregistered)";
  if (/forecast-value\.ts/.test(row.args)) return "forecast-value (unregistered)";
  return null;
}

function unmanagedParameters(row: ProcessRow): string {
  const values = [
    option(row.args, "llm") ? `model ${option(row.args, "llm")}` : "",
    option(row.args, "model") ? `model ${option(row.args, "model")}` : "",
    option(row.args, "settings") ? `arms ${option(row.args, "settings")}` : "",
    option(row.args, "compare") ? `arms ${option(row.args, "compare")}` : "",
    option(row.args, "arms") ? `arms ${option(row.args, "arms")}` : "",
    option(row.args, "n") ? `questions ${option(row.args, "n")}` : "",
    option(row.args, "conc") ? `conc ${option(row.args, "conc")}` : "",
    option(row.args, "max-tools") ? `max-tool ${option(row.args, "max-tools")}` : "",
    option(row.args, "max-tool-calls") ? `max-tool ${option(row.args, "max-tool-calls")}` : "",
    option(row.args, "effort") ? `effort ${option(row.args, "effort")}` : "",
  ].filter(Boolean);
  return [...new Set(values)].join(" | ") || "parameters only partly readable from the process command";
}

export function detectUnregisteredExperiments(registeredPids: number[]): UnregisteredExperiment[] {
  const registered = new Set(registeredPids);
  const rows = processRows().filter((row) => !registered.has(row.pid) && unmanagedName(row));
  const byKey = new Map<string, ProcessRow>();
  for (const row of rows) {
    const name = unmanagedName(row)!;
    const key = `${row.owner}:${name}`;
    const current = byKey.get(key);
    if (!current || row.pid < current.pid) byKey.set(key, row);
  }
  return [...byKey.values()].map((row) => ({
    owner: row.owner,
    pid: row.pid,
    parentPid: row.parentPid,
    elapsedSeconds: row.elapsedSeconds,
    name: unmanagedName(row)!,
    parameters: unmanagedParameters(row),
    note: /kimi_driver\.sh/.test(row.args)
      ? "not in the shared registry; may be waiting for quota to recover; completion count and ETA unknown"
      : "not in the shared registry; completion count and ETA unknown",
  }));
}

function dataDiskAvailable(): number | null {
  try {
    const stats = statfsSync(SHARED_ROOT);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export function buildSnapshot(registry: ExperimentRegistry, now = new Date()): ProgressSnapshot {
  const registeredRuns = registry.listRuns({ active: true });
  return {
    generatedAtUtc: now.toISOString(),
    timeZone: REPORT_TIME_ZONE,
    host: process.env.HOSTNAME?.trim() || SITE_NAME,
    load1: loadavg()[0] ?? 0,
    memoryAvailableBytes: freemem(),
    memoryTotalBytes: totalmem(),
    dataDiskAvailableBytes: dataDiskAvailable(),
    registeredRuns,
    unregisteredExperiments: detectUnregisteredExperiments(registeredRuns.map((run) => run.pid)),
  };
}

export function formatProgressReport(snapshot: ProgressSnapshot): string {
  const stale=snapshot.registeredRuns.filter(r=>r.status==='stale').length;
  const total = snapshot.registeredRuns.length-stale + snapshot.unregisteredExperiments.length;
  const lines = [
    "FABench experiment progress report",
    `Time: ${formatLocalTime(snapshot.generatedAtUtc)} (UTC+8)`,
    `Running experiments: ${total} (registry ${snapshot.registeredRuns.length-stale}, unregistered ${snapshot.unregisteredExperiments.length}); stale records to handle: ${stale}`,
    `Machine: ${SITE_NAME} | load ${snapshot.load1.toFixed(2)} | free memory ${formatBytes(snapshot.memoryAvailableBytes)}/${formatBytes(snapshot.memoryTotalBytes)}` +
      (snapshot.dataDiskAvailableBytes === null ? "" : ` | free data disk ${formatBytes(snapshot.dataDiskAvailableBytes)}`),
  ];

  let index = 0;
  for (const run of snapshot.registeredRuns) {
    index++;
    const estimate = estimateProgress(run, Date.parse(snapshot.generatedAtUtc));
    lines.push(
      "",
      `${index}. ${run.tag} (${run.owner})`,
      `Status: ${run.status === "stale" ? "needs a check" : "running"}`,
      `Progress: ${estimate.terminalCells}/${run.expectedCells} (${estimate.progressPercent.toFixed(1)}%) | succeeded ${run.succeededCells} | reused ${run.reusedCells} | failed ${run.failedCells}`,
      `Main parameters: ${configSummary(run)}`,
      `Elapsed: ${formatDuration(estimate.elapsedMs)}${run.status==='stale'?' (up to the last heartbeat; actual exit time unknown)':''}`,
      `Estimated time: ${estimate.remainingMs === null
        ? "no estimate yet"
        : `about ${formatDuration(estimate.remainingMs)} left, about ${formatDuration(estimate.totalMs)} in total, done around ${formatLocalTime(estimate.etaUtc!)}`}`,
      `Notes: ${runNotes(run)}`,
    );
  }

  for (const run of snapshot.unregisteredExperiments) {
    index++;
    lines.push(
      "",
      `${index}. ${run.name} (${run.owner})`,
      "Status: process detected",
      "Progress: unknown (not in the shared registry)",
      `Main parameters: ${run.parameters}`,
      `Elapsed: ${formatDuration(run.elapsedSeconds * 1000)}`,
      "Estimated time: no estimate yet",
      `Notes: ${run.note}`,
    );
  }

  if (total === 0) lines.push("", "No running experiment detected.");
  return lines.join("\n");
}

/** Build a wide Feishu card with a compact summary table plus readable per-run details. */
export function buildFeishuMessage(snapshot: ProgressSnapshot): Record<string, unknown> {
  const generatedAtMs = Date.parse(snapshot.generatedAtUtc);
  const registered = snapshot.registeredRuns.map((run) => ({
    kind: "registered" as const,
    run,
    estimate: estimateProgress(run, generatedAtMs),
  }));
  const unregistered = snapshot.unregisteredExperiments.map((run) => ({
    kind: "unregistered" as const,
    run,
  }));
  const experiments = [...registered, ...unregistered];
  const staleCount=registered.filter(item=>item.run.status==='stale').length;
  const hasCritical = snapshot.registeredRuns.some((run) => run.status === "stale");
  const hasWarning = snapshot.registeredRuns.some((run) => run.failedCells > 0)
    || snapshot.unregisteredExperiments.length > 0;
  const elements: Record<string, unknown>[] = [
    {
      tag: "div",
      fields: [
        {
          is_short: true,
          text: { tag: "lark_md", content: `**Report time**\n${formatLocalTime(snapshot.generatedAtUtc)} (UTC+8)` },
        },
        {
          is_short: true,
          text: { tag: "lark_md", content: `**Running experiments**\n${experiments.length-staleCount} (registered ${registered.length-staleCount} | unregistered ${unregistered.length})\nStale records to handle: ${staleCount}` },
        },
        {
          is_short: true,
          text: { tag: "lark_md", content: `**Machine load**\n${snapshot.load1.toFixed(2)} (1 min)` },
        },
        {
          is_short: true,
          text: {
            tag: "lark_md",
            content: `**Free resources**\nmemory ${formatBytes(snapshot.memoryAvailableBytes)} | disk ${snapshot.dataDiskAvailableBytes === null ? "—" : formatBytes(snapshot.dataDiskAvailableBytes)}`,
          },
        },
      ],
    },
    { tag: "hr" },
    cardText("**Run overview**"),
    cardTableRow([
      { content: "Experiment", weight: 4 },
      { content: "Progress", weight: 2 },
      { content: "Elapsed", weight: 2 },
      { content: "ETA", weight: 2 },
    ], true),
  ];

  experiments.forEach((item, index) => {
    if (item.kind === "registered") {
      const { run, estimate } = item;
      const icon = run.status === "stale" ? "🔴" : run.failedCells > 0 ? "🟠" : "🟢";
      elements.push(cardTableRow([
        {
          content: `${icon} **${escapeLarkMarkdown(friendlyModel(run), 42)}**\n${escapeLarkMarkdown(run.owner, 20)}`,
          weight: 4,
        },
        {
          content: `**${estimate.progressPercent.toFixed(1)}%**\n${estimate.terminalCells}/${run.expectedCells}`,
          weight: 2,
        },
        { content: formatDuration(estimate.elapsedMs), weight: 2 },
        {
          content: estimate.remainingMs === null
            ? "no estimate yet"
            : `about ${formatDuration(estimate.remainingMs)}\n${formatLocalTime(estimate.etaUtc!)}`,
          weight: 2,
        },
      ], false, index % 2 === 1));
    } else {
      elements.push(cardTableRow([
        {
          content: `🟡 **${escapeLarkMarkdown(item.run.name, 42)}**\n${escapeLarkMarkdown(item.run.owner, 20)}`,
          weight: 4,
        },
        { content: "Unregistered\nprogress unknown", weight: 2 },
        { content: formatDuration(item.run.elapsedSeconds * 1000), weight: 2 },
        { content: "—", weight: 2 },
      ], false, index % 2 === 1));
    }
  });

  if (experiments.length === 0) {
    elements.push(cardText("✅ No running experiment detected."));
  } else {
    elements.push({ tag: "hr" }, cardText("**Parameters and notes**"));
    registered.forEach(({ run, estimate }, index) => {
      elements.push({
        tag: "div",
        fields: [
          {
            is_short: true,
            text: {
              tag: "lark_md",
              content: `**${index + 1}. ${escapeLarkMarkdown(friendlyModel(run), 48)}**\n${escapeLarkMarkdown(run.tag, 80)}`,
            },
          },
          {
            is_short: true,
            text: {
              tag: "lark_md",
              content: `**Results**\nsucceeded ${run.succeededCells} | reused ${run.reusedCells} | failed ${run.failedCells}`,
            },
          },
          {
            is_short: false,
            text: { tag: "lark_md", content: `**Main parameters**\n${escapeLarkMarkdown(configSummary(run), 280)}` },
          },
          {
            is_short: false,
            text: {
              tag: "lark_md",
              content: `**Notes**\n${escapeLarkMarkdown(runNotes(run), 240)}; estimated total ${formatDuration(estimate.totalMs)}`,
            },
          },
        ],
      });
    });
    unregistered.forEach(({ run }, index) => {
      elements.push({
        tag: "div",
        fields: [
          {
            is_short: true,
            text: {
              tag: "lark_md",
              content: `**${registered.length + index + 1}. ${escapeLarkMarkdown(run.name, 60)}**\n${escapeLarkMarkdown(run.owner, 20)}`,
            },
          },
          {
            is_short: true,
            text: { tag: "lark_md", content: "**Status**\nprocess detected | not in the registry" },
          },
          {
            is_short: false,
            text: { tag: "lark_md", content: `**Main parameters**\n${escapeLarkMarkdown(run.parameters, 280)}` },
          },
          {
            is_short: false,
            text: { tag: "lark_md", content: `**Notes**\n${escapeLarkMarkdown(run.note, 240)}` },
          },
        ],
      });
    });
  }

  elements.push(
    { tag: "hr" },
    cardText("Next scheduled report: daily at **00:00 / 06:00 / 12:00 / 18:00** (UTC+8)"),
  );
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: hasCritical ? "red" : hasWarning ? "orange" : "blue",
        title: { tag: "plain_text", content: "FABench · Experiment progress" },
      },
      elements,
    },
  };
}

export function feishuSignature(timestamp: number, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

export async function sendToFeishu(
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const webhook = projectEnv("FABENCH_FEISHU_WEBHOOK_URL")?.trim();
  if (!webhook) throw new Error("FABENCH_FEISHU_WEBHOOK_URL is required for --send");
  let endpoint: URL;
  try {
    endpoint = new URL(webhook);
  } catch {
    throw new Error("FABENCH_FEISHU_WEBHOOK_URL is not a valid URL");
  }
  const allowedHosts = new Set(["open.feishu.cn", "open.larksuite.com"]);
  if (
    endpoint.protocol !== "https:"
    || !allowedHosts.has(endpoint.hostname)
    || !endpoint.pathname.startsWith("/open-apis/bot/v2/hook/")
  ) {
    throw new Error("FABENCH_FEISHU_WEBHOOK_URL must be an official Feishu/Lark v2 bot webhook");
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = projectEnv("FABENCH_FEISHU_WEBHOOK_SECRET")?.trim();
  const body: Record<string, unknown> = {
    ...message,
    ...(secret ? { timestamp, sign: feishuSignature(timestamp, secret) } : {}),
  };
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const kind = error instanceof Error ? error.name : "UnknownError";
    throw new Error(`Feishu webhook request failed (${kind})`);
  }
  const responseText = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    parsed = { raw: responseText.slice(0, 500) };
  }
  const apiCode = parsed.code ?? parsed.StatusCode ?? 0;
  if (!response.ok || Number(apiCode) !== 0) {
    throw new Error(`Feishu webhook failed: HTTP ${response.status}, response=${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function archive(
  snapshot: ProgressSnapshot,
  report: string,
  feishuMessage: Record<string, unknown>,
  sendResult: Record<string, unknown> | null,
): string {
  const directory = projectEnv("FABENCH_PROGRESS_ARCHIVE_DIR")?.trim() || DEFAULT_ARCHIVE_DIR;
  mkdirSync(directory, { recursive: true, mode: 0o2775 });
  const stamp = snapshot.generatedAtUtc.replaceAll(/[-:]/g, "").replace(".000", "");
  const base = join(directory, stamp);
  writeFileSync(`${base}.txt`, `${report}\n`, { mode: 0o664 });
  writeFileSync(`${base}.json`, `${JSON.stringify({ snapshot, feishuMessage, sendResult }, null, 2)}\n`, { mode: 0o664 });
  return base;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  const send = argv.includes("--send");
  const json = argv.includes("--json");
  const unknown = argv.filter((arg) => !["--send", "--json"].includes(arg));
  if (unknown.length) throw new Error(`unknown arguments: ${unknown.join(", ")}`);
  const registry = new ExperimentRegistry();
  try {
    const snapshot = buildSnapshot(registry);
    const report = formatProgressReport(snapshot);
    const feishuMessage = buildFeishuMessage(snapshot);
    if (json) console.log(JSON.stringify(snapshot, null, 2));
    else console.log(report);
    let sendResult: Record<string, unknown> | null = null;
    try {
      sendResult = send ? await sendToFeishu(feishuMessage) : null;
    } catch (error) {
      const archiveBase = archive(snapshot, report, feishuMessage, {
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`[ERR] send failed; archive=${archiveBase}.{txt,json}`);
      throw error;
    }
    const archiveBase = archive(snapshot, report, feishuMessage, sendResult);
    console.error(`${send ? "[OK] sent" : "[OK] preview"}; archive=${archiveBase}.{txt,json}`);
  } finally {
    registry.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`[ERR] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
