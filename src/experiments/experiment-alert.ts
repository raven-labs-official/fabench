/** Send one lifecycle alert for a shared FABench experiment. */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sendToFeishu } from "./progress-report.js";
import { SHARED_BENCH_DIR } from "../path-config.js";
import { projectEnv } from "../env-names.js";

export type ExperimentAlertEvent = "start" | "interrupted" | "failed" | "completed";

export interface ExperimentAlertInput {
  event: ExperimentAlertEvent;
  owner: string;
  pid: number;
  release: string;
  exitCode: number | null;
  signal: string | null;
  reason?: string | null;
  experimentArgs: string[];
  occurredAtUtc: string;
}

function option(args: string[], name: string): string | null {
  const equals = args.find((arg) => arg.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3) || null;
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function localTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: projectEnv("FABENCH_PROGRESS_TIME_ZONE")?.trim() || "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso)).replaceAll("/", "-");
}

function safe(value: string | null, maxLength = 120): string {
  const compact = (value ?? "—").replace(/\s+/g, " ").trim();
  const truncated = compact.length > maxLength
    ? `${compact.slice(0, maxLength - 1)}…`
    : compact;
  return truncated
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\*_`\[\]])/g, "\\$1");
}

function field(label: string, value: string): Record<string, unknown> {
  return {
    is_short: true,
    text: { tag: "lark_md", content: `**${label}**\n${value}` },
  };
}

export function buildExperimentAlert(
  input: ExperimentAlertInput,
): Record<string, unknown> {
  const tag = option(input.experimentArgs, "tag") ?? "unnamed experiment";
  const model = option(input.experimentArgs, "llm") ?? "unknown";
  const mode = option(input.experimentArgs, "settings") ?? option(input.experimentArgs, "compare") ?? "unknown";
  const questionCount = option(input.experimentArgs, "n")
    ?? (option(input.experimentArgs, "ids-file") ? "fixed question list" : "default");
  const conc = option(input.experimentArgs, "conc") ?? "default";
  const maxTools = option(input.experimentArgs, "max-tool-calls") ?? "default";
  const primaryFilter = option(input.experimentArgs, "leak-llm");
  const fallbackFilter = option(input.experimentArgs, "leak-fallback-llm");
  const titles: Record<ExperimentAlertEvent, string> = {
    start: "FABench · Experiment started",
    completed: "FABench · Round summary",
    interrupted: "FABench · Experiment interrupted",
    failed: "FABench · Experiment ended abnormally",
  };
  const icons: Record<ExperimentAlertEvent, string> = {
    start: "🚀",
    completed: "✅",
    interrupted: "🔴",
    failed: "🔴",
  };
  const templates: Record<ExperimentAlertEvent, string> = {
    start: "blue",
    completed: "green",
    interrupted: "red",
    failed: "red",
  };
  const status = input.event === "start"
    ? "run process created"
    : [
        input.reason?.trim() || "",
        input.signal ? `signal=${input.signal}` : "",
        input.exitCode === null ? "" : `exit=${input.exitCode}`,
      ].filter(Boolean).join(" | ") || "abnormal exit";
  const filters = [
    primaryFilter ? `primary ${primaryFilter}` : "",
    fallbackFilter ? `fallback ${fallbackFilter}` : "",
  ].filter(Boolean).join(" | ") || "n/a";

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: templates[input.event],
        title: { tag: "plain_text", content: `${icons[input.event]} ${titles[input.event]}` },
      },
      elements: [
        {
          tag: "div",
          fields: [
            field("Experiment", safe(tag, 100)),
            field("Status", safe(status, 2000)),
            field("Model / arms", `${safe(model, 70)} | ${safe(mode, 50)}`),
            field("Questions / concurrency", `${safe(questionCount, 50)} questions | conc=${safe(conc, 20)}`),
            field("Tool budget", `max-tool=${safe(maxTools, 20)}`),
            field("Operator / PID", `${safe(input.owner, 30)} | ${input.pid}`),
          ],
        },
        { tag: "hr" },
        {
          tag: "div",
          fields: [
            field("Filter", safe(filters, 180)),
            field("Pinned release", safe(basename(input.release), 60)),
            field("Time", `${localTime(input.occurredAtUtc)} (UTC+8)`),
          ],
        },
      ],
    },
  };
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function parseInteger(value: string | null, name: string): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const controlArgs = separator >= 0 ? argv.slice(0, separator) : argv;
  const experimentArgs = separator >= 0 ? argv.slice(separator + 1) : [];
  const event = requiredOption(controlArgs, "event") as ExperimentAlertEvent;
  if (!["start", "interrupted", "failed", "completed"].includes(event))
    throw new Error(`unsupported --event: ${event}`);
  const input: ExperimentAlertInput = {
    event,
    owner: requiredOption(controlArgs, "owner"),
    pid: parseInteger(requiredOption(controlArgs, "pid"), "pid")!,
    release: requiredOption(controlArgs, "release"),
    exitCode: parseInteger(option(controlArgs, "exit-code"), "exit-code"),
    signal: option(controlArgs, "signal"),
    reason: option(controlArgs, "reason"),
    experimentArgs,
    occurredAtUtc: new Date().toISOString(),
  };
  const message = buildExperimentAlert(input);
  const response = await sendToFeishu(message);
  const directory = projectEnv("FABENCH_EXPERIMENT_ALERT_ARCHIVE_DIR")?.trim()
    || join(SHARED_BENCH_DIR, "experiment-alerts");
  mkdirSync(directory, { recursive: true, mode: 0o2775 });
  const stamp = input.occurredAtUtc.replaceAll(/[-:]/g, "").replace(".000", "");
  const filename = join(directory, `${stamp}-${input.event}-${input.pid}.json`);
  writeFileSync(filename, `${JSON.stringify({ input, message, response }, null, 2)}\n`, {
    mode: 0o664,
  });
  console.error(`[OK] Feishu ${event} alert sent; archive=${filename}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(`[ERR] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
