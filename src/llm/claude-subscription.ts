/** Claude subscription forecasts: closed-book CLI and per-question FABench MCP retrieval. */
import {claudeTokenUsage} from "./claude-usage.js";
import {execFileSync, spawn} from "node:child_process";
import {mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {LlmClient, LlmCompletion, LlmRequest, ReasoningConfiguration} from "./benchmark-client.js";
import {ProviderApiError} from "./openai-compatible.js";
import {sha256} from "../tracing/trace-archive.js";
import {TEAM_CONFIG_DIR} from "../path-config.js";
import {ClaudeRetrievalForecast} from "./claude-retrieval.js";
import {CODEX_NONE_SYSTEM} from "./codex-subscription.js";

/** Byte-identical to the reviewed Codex none system, so the two subscription harnesses stay comparable. */
export const CLAUDE_NONE_SYSTEM = CODEX_NONE_SYSTEM;
export const CLAUDE_MODEL = "claude-opus-5";
export const CLAUDE_OPUS_55_MODEL = "claude-opus-5-5";
export type ClaudeModel = typeof CLAUDE_MODEL | typeof CLAUDE_OPUS_55_MODEL;
export const CLAUDE_WRAPPER = "/usr/local/bin/claude-raven";
/** Resolved through PATH like the Codex entry point, so a test can shim the team wrapper. */
export const CLAUDE_COMMAND = "claude-raven";
export const CLAUDE_ENTRYPOINT = "/usr/bin/claude";

/**
 * Claude Code keeps a tool surface even under --restricted and --strict-mcp-config: a probe on
 * 2.1.266 still reported Read/Write/Grep/Task and, fatally for a closed book, WebSearch. Denying
 * them by name empties the surface, and the init event is checked below so an added built-in in a
 * later CLI cannot silently re-open retrieval.
 */
export const CLAUDE_TOOLS_OFF = [
  "Task", "Bash", "BashOutput", "KillShell", "Edit", "Write", "Read", "Glob", "Grep", "NotebookEdit",
  "WebSearch", "WebFetch", "TodoWrite", "SlashCommand", "Skill", "ToolSearch", "Artifact",
  "ArtifactComments", "ArtifactData", "CronCreate", "CronDelete", "CronList", "DesignSync",
  "EnterWorktree", "ExitWorktree", "EnterPlanMode", "ExitPlanMode", "ListAgents", "SendMessage",
  "PushNotification", "ScheduleWakeup", "ReportFindings", "TaskOutput", "TaskStop", "Monitor",
  "ListSkills", "SearchSkills", "ListPlugins", "SearchPlugins", "SuggestPluginInstall",
] as const;

/**
 * A subscription window that is spent is not a transient 429 to back off from: waiting it out
 * inside a cell would burn the remaining questions on retries. It is reported as a non-retryable
 * insufficient_balance so the runner opens its provider circuit, keeps every finished cell and
 * stops dispatching until the window resets.
 */
const CLAUDE_WINDOW_EXHAUSTED = /usage limit|rate limit|limit reached|hit your (?:weekly )?limit|too many requests|\b429\b|resets? at/i;
export function claudeWindowExhausted(rateLimit: any, text: string): boolean {
  const status = rateLimit?.status;
  if (status === "rejected") return true;
  return CLAUDE_WINDOW_EXHAUSTED.test(text);
}

/** Events the transport understands. Anything else fails the cell rather than being ignored. */
const CLAUDE_EVENTS = new Set(["system", "assistant", "result", "rate_limit_event"]);
/** Only prose and returned thinking are admissible content. */
const CLAUDE_BLOCKS = new Set(["text", "thinking", "redacted_thinking"]);

/** No inference, credential values, or login changes. Pin the installed runtime in the condition. */
export function inspectClaudeSubscription() {
  const version = execFileSync(CLAUDE_COMMAND, ["status"], {encoding: "utf8", timeout: 30_000})
    .split("\n").map(line => /wrapper=([0-9a-f]{8})/.exec(line)?.[1]).find(Boolean);
  if (!version) throw new Error("claude-raven did not report a wrapper build; the shared entry point is required");
  const cli = execFileSync(CLAUDE_ENTRYPOINT, ["--version"], {encoding: "utf8", timeout: 30_000}).trim().split("\n").at(-1)!;
  const token = tokenFingerprint();
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
    throw new Error("Claude subscription pilot forbids an API-key fallback in the environment");
  return {
    cli_version: cli, wrapper_build: version,
    executable_sha256: sha256(readFileSync(realpathSync(CLAUDE_ENTRYPOINT))),
    wrapper_sha256: sha256(readFileSync(CLAUDE_WRAPPER)),
    authentication: "claude_subscription_oauth", credential_fingerprint: token,
  };
}

/** Shared team credential identity only; the token value never reaches a trace or a log. */
export function tokenFingerprint(path = join(TEAM_CONFIG_DIR, "claude-raven", "auth.env")): string {
  const line = readFileSync(path, "utf8").split("\n").find(row => row.startsWith("CLAUDE_CODE_OAUTH_TOKEN="));
  const value = line?.slice("CLAUDE_CODE_OAUTH_TOKEN=".length).trim();
  if (!value?.startsWith("sk-ant-oat01-")) throw new Error("Shared Claude credential must be a long-lived subscription token");
  return sha256(value).slice(0, 12);
}

export function claudeInput(req: LlmRequest, model: ClaudeModel = CLAUDE_MODEL) {
  const messages = req.messages ?? [{role: "system", content: req.system ?? ""}, {role: "user", content: req.prompt}];
  if (req.model && req.model !== model) throw new Error("Subscription model override is outside the authorized scope");
  if (req.tools?.length || messages.length !== 2 || messages[0]?.role !== "system" || messages[1]?.role !== "user" ||
      messages.some(m => m.toolCalls?.length || m.toolCallId) || messages[0].content !== CLAUDE_NONE_SYSTEM)
    throw new Error("Claude pilot accepts only the reviewed none system and one fresh question, with no tools/history");
  return {system: messages[0].content, prompt: messages[1].content};
}

export function claudeArguments(system: string, emptyCwd: string, effort?: string, model: ClaudeModel = CLAUDE_MODEL): string[] {
  return ["-p", "--model", model, "--system-prompt", system,
    "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--restricted",
    "--settings", "{}", "--add-dir", emptyCwd, "--permission-mode", "dontAsk",
    "--disallowedTools", ...CLAUDE_TOOLS_OFF,
    ...(effort ? ["--effort", effort] : [])];
}

/** A retrieval tool, an extra turn or a failed result invalidates the entire cell. */
export function inspectClaudeEvent(event: any, model: ClaudeModel = CLAUDE_MODEL) {
  if (!CLAUDE_EVENTS.has(event?.type)) throw new Error(`Unsupported Claude CLI event: ${event?.type}`);
  inspectClaudeRateLimitError(event);
  if (event.type === "system" && event.subtype === "init") {
    if (event.tools?.length) throw new Error(`Closed-book violation: CLI offered tools ${event.tools.join(",")}`);
    if (event.mcp_servers?.length) throw new Error("Closed-book violation: CLI loaded MCP servers");
  }
  if (event.type === "assistant") {
    if (event.message?.model && event.message.model !== model)
      throw new Error(`Model fallback: cell answered by ${event.message.model}`);
    for (const block of event.message?.content ?? [])
      if (!CLAUDE_BLOCKS.has(block?.type)) throw new Error(`Closed-book violation or unsupported Claude block: ${block?.type}`);
  }
  if (event.type === "result") {
    if (event.is_error || event.subtype !== "success")
      throw new Error(`Claude failed: ${JSON.stringify(event.subtype ?? event.result)}`);
    // The CLI bills side work (titles, summaries) to an auxiliary model. Non-essential traffic is
    // switched off below, so a second model in the ledger means the cell was not a single pinned call.
    for (const billedModel of Object.keys(event.modelUsage ?? {}))
      if (billedModel !== model) throw new Error(`Auxiliary model billed inside the cell: ${billedModel}`);
  }
}

/** Local CLI quota errors can use a synthetic model name; classify them before model validation. */
export function inspectClaudeRateLimitError(event:any) {
  if(event.type==='assistant' && event.error==='rate_limit')
    throw new Error('Claude rate limit: '+(event.message?.content??[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n'));
}

export class ClaudeSubscriptionClient implements LlmClient {
  readonly id: string;
  readonly traceMetadata: Readonly<Record<string, unknown>>;
  constructor(runtime = inspectClaudeSubscription(), private readonly model: ClaudeModel = CLAUDE_MODEL) {
    this.id = `claude:${model}`;
    this.traceMetadata = {
      harness: "claude-cli-raven-mcp-v1", base_url: "claude-subscription-via-claude-raven",
      runtime, model, credential_resource: `claude-raven-subscription:${(runtime as any).credential_fingerprint}`,
      pricing: {known: false, usd_cost_known: false, billing: "claude_subscription"},
      isolation: {
        fresh_context: true, fresh_config_dir: true, web_search: "denied", mcp: "strict Raven bridge for retrieval; none for closed book",
        denied_tools: CLAUDE_TOOLS_OFF, tool_surface_checked: "system.init tools[] and mcp_servers[] checked against arm allowlist",
        retrieval_tool_names: "mcp__raven__web_search / mcp__raven__web_fetch",
        budget_notice: "verbatim extra MCP content block; Raven enforces execution cap",
        native_history: "same question only; auto-compaction disabled and system compaction events rejected",
        replay_cot: false, question_prompt: "verbatim", system_prompt: "--system-prompt replacement",
        claude_environment_messages: "CLI may add environment metadata; distinct harness",
        nonessential_traffic: "disabled", auxiliary_model: "rejected in modelUsage",
      },
      reasoning_visibility: "Only CLI-returned thinking blocks are observable; not a claim of full hidden CoT",
    };
  }
  reasoningConfiguration(effort?: string): ReasoningConfiguration {
    return {
      reasoning_mode: effort ? "reasoning" : null, thinking_effort: effort ?? null,
      requested_thinking_effort: effort ?? null, source: effort ? "explicit" : "provider-default",
      api_parameters: {harness_runtime: (this.traceMetadata as any).runtime, isolation: (this.traceMetadata as any).isolation,
        ...(effort ? {effort} : {})},
    };
  }
  openForecast(): LlmClient & {close():void} {
    let retrieval:ClaudeRetrievalForecast|undefined;
    return {id:this.id,traceMetadata:this.traceMetadata,complete:(req)=>{
      if(req.tools?.length || retrieval) {
        retrieval ??= new ClaudeRetrievalForecast(this.traceMetadata, this.model);
        return retrieval.complete(req);
      }
      return this.complete(req);
    },close:()=>retrieval?.close()};
  }
  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const input = claudeInput(req, this.model);
    const root = mkdtempSync(join(tmpdir(), "raven-claude-none-"));
    const cwd = join(root, "empty"); mkdirSync(cwd, {mode: 0o700});
    const configDir = join(root, "config"); mkdirSync(configDir, {mode: 0o700});
    const args = claudeArguments(input.system, cwd, req.effort, this.model);
    const expectedModel = this.model;
    const env: NodeJS.ProcessEnv = {...process.env, CLAUDE_RAVEN_CONFIG_DIR: configDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1"};
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
    let raw = "", stderr = "", sessionId: string | undefined, usage: any, text: string | undefined, turns = 0, results = 0;
    let modelUsage: any, rateLimit: any;
    const thinking: string[] = [];
    req.onTrace?.({type: "claude_invocation", data: {command: CLAUDE_COMMAND, args, runtime: (this.traceMetadata as any).runtime,
      system_sha256: sha256(input.system), prompt_sha256: sha256(input.prompt), billing: "claude_subscription"}});
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(CLAUDE_COMMAND, args, {cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true});
        let failure: Error | undefined;
        const stop = (error: Error) => {failure ??= error; try {process.kill(-child.pid!, "SIGTERM");} catch {}};
        const timeout = setTimeout(() => stop(new Error("Claude cell exceeded 15 minute limit")), 900_000);
        const interrupt = () => stop(new Error("Claude cell interrupted by parent"));
        process.once("SIGTERM", interrupt); process.once("SIGINT", interrupt);
        function line(value: string) {
          if (!value.trim()) return;
          try {
            const event = JSON.parse(value);
            req.onTrace?.({type: "claude_event", data: event});
            inspectClaudeEvent(event, expectedModel);
            if (event.type === "system" && event.subtype === "init") {
              if (sessionId) throw new Error("Multiple Claude sessions in one cell");
              sessionId = event.session_id;
            }
            if (event.type === "result") {
              results++; usage = event.usage; turns = event.num_turns ?? 0; text = event.result;
              modelUsage = event.modelUsage;
            }
            if (event.type === "rate_limit_event") rateLimit = event.rate_limit_info;
            for (const block of event.type === "assistant" ? event.message?.content ?? [] : [])
              if (block.type === "thinking" && block.thinking) thinking.push(block.thinking);
          } catch (error) {stop(error instanceof Error ? error : new Error(String(error)));}
        }
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
        child.stdout.on("data", (part: string) => {raw += part; let end; while ((end = raw.indexOf("\n")) >= 0) {line(raw.slice(0, end)); raw = raw.slice(end + 1);}});
        child.stderr.on("data", (part: string) => {stderr += part;});
        child.on("error", error => {failure = error;});
        child.on("close", code => {
          clearTimeout(timeout); process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt);
          if (raw.trim()) line(raw);
          if (stderr) req.onTrace?.({type: "claude_stderr", data: {text: stderr}});
          if (failure) reject(failure);
          else if (code !== 0 || results !== 1 || turns !== 1 || !sessionId || !text)
            reject(new Error(`Claude exit=${code}; results=${results}; turns=${turns}; ${stderr.slice(-2000)}`));
          else resolve();
        });
        child.stdin.on("error", () => {}); child.stdin.end(input.prompt);
      });
      const cot = thinking.join("\n\n");
      const capture = {policy: "raven.provider-reasoning.v1" as const,
        status: cot.trim() ? "text_returned" as const : "not_returned" as const,
        native_fields: thinking.length ? ["claude.assistant.thinking"] : [], native_frames: thinking.length,
        native_trace_enabled: !!req.onTrace, readable_source: thinking.length ? "claude.assistant.thinking" : null,
        readable_chars: cot.length, readable_sha256: sha256(cot), stream_complete: true};
      req.onTrace?.({type: "provider_reasoning_capture", data: capture});
      req.onTrace?.({type: "claude_cell_accounting", data: {native_usage: usage, model_usage: modelUsage, rate_limit: rateLimit,
        billing: "claude_subscription", usd_cost_known: false}});
      return {text: text!, reasoning: cot, reasoningCapture: capture, costUsd: 0,
        ...claudeTokenUsage(usage),
        reasoningTokens: usage?.output_tokens_details?.thinking_tokens,
        provider: {responseId: sessionId}, finishReason: "stop"};
    } catch (error) {
      const exhausted = claudeWindowExhausted(rateLimit, `${String(error)} ${stderr} ${text ?? ""}`);
      req.onTrace?.({type: "claude_failed_capture", data: {stream_complete: false, thinking_blocks: thinking.length,
        partial_json_line: raw, rate_limit: rateLimit, window_exhausted: exhausted, error: String(error)}});
      // Never auto-retry an uncertain subscription generation, model fallback or a tool violation.
      if (exhausted)
        throw new ProviderApiError(this.id, 429, "insufficient_balance", false,
          "claude_subscription_window_exhausted", String(error));
      throw new ProviderApiError(this.id, 400, "http_error", false, "claude_no_automatic_retry", String(error));
    } finally {rmSync(root, {recursive: true, force: true});}
  }
}
