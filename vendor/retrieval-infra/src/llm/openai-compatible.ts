import {setTimeout as abortablePause} from 'node:timers/promises';
import {timingSpan} from '../observability/timeline.js';
/**
 * OpenAiCompatibleClient — LlmClient for any OpenAI-compatible chat-completions
 * API (Kimi/Moonshot, GLM/Zhipu, OpenAI, OpenRouter, vLLM, …).
 *
 * One implementation serves every such provider; only base URL + key + model
 * differ. This is the point of the LlmClient seam: new backends are config, not
 * new predictor code.
 *
 * OpenRouter reports per-call USD cost directly. Other providers use native
 * prices preserved in trace metadata; costUsd is only derived when those
 * prices are already denominated in USD.
 */
import { isNativeDeepSeekFlash, deepseekFlashPriceCard, DEEPSEEK_FLASH_DOCUMENTATION } from "./deepseek-flash.js";
import {ProviderReasoningCapture,REASONING_RETENTION_POLICY,type ReasoningCaptureMetadata} from "./reasoning-capture.js";
import { apiResource, sharedRateLimiter, RATE_POLICY, type SharedRateLimiter } from "./shared-rate-limit.js";
import type {
  LlmClient,
  LlmRequest,
  LlmCompletion,
  ReasoningConfiguration,
} from "./client.js";
import { projectEnv } from "../env-names.js";

export interface OpenAiCompatibleOptions {
  /** Short provider id for the client id / logs, e.g. "glm". */
  providerId: string;
  apiKey: string;
  /** Base URL WITHOUT the trailing /chat/completions, e.g. https://open.bigmodel.cn/api/paas/v4 */
  baseUrl: string;
  model: string;
  /** Restrict per-request overrides when credentials are scoped to selected models. */
  allowedModels?: readonly string[];
  /** Non-secret resource alias for auditing which team credential was selected. */
  credentialResource?: string;
  /** Default 180_000 (3 min). */
  timeoutMs?: number;
  /** Sampling temperature. Default 0.3 (low, but allows mild ensemble diversity). */
  temperature?: number;
  /** Native provider price per 1M input/output tokens. Default 0. */
  priceInputPerM?: number;
  /**
   * Price per 1M input tokens that the provider served from its prompt cache.
   * Defaults to the full input price, which is the safe assumption for providers that
   * neither cache nor report caching.
   */
  priceCacheHitPerM?: number;
  priceOutputPerM?: number;
  /** ISO-style billing currency for the native price card. Default USD. */
  pricingCurrency?: string;
  /** Whether the native prices can be summed directly into costUsd. */
  usdCostKnown?: boolean;
  /** False for subscriptions or gateways where token usage has no attributable price. */
  pricingKnown?: boolean;
  /** Explicit, opt-in native Flash diagnostic settings; omitted preserves provider defaults. */
  thinking?: "disabled";
  maxOutputTokens?: number;
  /** Injectable admission boundary for offline transport tests. */
  admission?: Pick<SharedRateLimiter, "acquire">;
}

export type ProviderErrorCategory =
  | "insufficient_balance"
  | "rate_limited"
  | "authentication"
  | "reasoning_replay_required"
  | "server_error"
  | "http_error";

class IncompleteProviderStream extends Error {
  readonly name = "IncompleteProviderStream";
}

/** Exhausted network/stream attempts, distinct from malformed model output. */
export class ProviderTransportError extends Error {
  readonly name = "ProviderTransportError";
  constructor(readonly providerId: string, readonly attempts: number,
    readonly phase: string, cause: unknown) {
    super(`${providerId} transport failed after ${attempts} attempts (${phase}): ${cause instanceof Error ? cause.message : String(cause)}`, {cause});
  }
}

/** A provider response whose retry and run-level handling must not depend on message regexes. */
export class ProviderApiError extends Error {
  readonly name = "ProviderApiError";

  constructor(
    readonly providerId: string,
    readonly status: number,
    readonly category: ProviderErrorCategory,
    readonly retryable: boolean,
    readonly providerCode: string | null,
    readonly bodyExcerpt: string,
  ) {
    super(
      `${providerId} API ${status} (${category})` +
        (providerCode ? ` code=${providerCode}` : "") +
        (bodyExcerpt ? `: ${bodyExcerpt.slice(0, 220)}` : ""),
    );
  }
}

export function classifyProviderHttpError(
  providerId: string,
  status: number,
  body: string,
): ProviderApiError {
  let providerCode: string | null = null;
  let message = body.trim();
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown };
      code?: unknown;
      message?: unknown;
    };
    const code = parsed.error?.code ?? parsed.code;
    providerCode = code == null ? null : String(code);
    const parsedMessage = parsed.error?.message ?? parsed.message;
    if (typeof parsedMessage === "string") message = parsedMessage;
  } catch {
    // Plain-text provider errors are still classified by status/message below.
  }
  const insufficient =
    (providerId === "glm" && providerCode === "1113") ||
    /insufficient[_-](?:quota|balance|credits?)|quota[_-]exhausted|usage_limit_exceeded/i.test(providerCode ?? "") ||
    /余额不足|无可用资源包|请充值|insufficient\s+(?:balance|credits?|quota)|not enough credits?/i.test(
      message,
    );
  const reasoningReplayRequired = providerId === "deepseek" && status === 400
    && /reasoning_content.*(?:must be passed back|is required|is missing)/i.test(message);
  // DashScope uses this OpenAI-compatible code for TPS/TPM throttling, not billing.
  // https://help.aliyun.com/zh/model-studio/error-code#token-limit
  const bailianTokenRateLimit = providerId === "bailian" && status === 429
    && providerCode === "insufficient_quota";
  const category: ProviderErrorCategory = reasoningReplayRequired
    ? "reasoning_replay_required"
    : bailianTokenRateLimit
    ? "rate_limited"
    : insufficient
    ? "insufficient_balance"
    : status === 429
      ? "rate_limited"
      : status === 401 || status === 403
        ? "authentication"
        : status >= 500
          ? "server_error"
          : "http_error";
  return new ProviderApiError(
    providerId,
    status,
    category,
    category === "rate_limited" || category === "server_error",
    providerCode,
    message.slice(0, 500),
  );
}

export function isNonRetryableProviderApiError(error: unknown): error is ProviderApiError {
  return error instanceof ProviderApiError && !error.retryable;
}

interface WireToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * 2x during the provider's peak windows, 1x otherwise.
 *
 * Set FABENCH_PEAK_MULTIPLIER=1 to disable if a provider drops the surcharge; the windows
 * themselves are the provider's, so they live here rather than in each caller.
 */
export function peakMultiplier(at = new Date()): number {
  const override = Number(projectEnv("FABENCH_PEAK_MULTIPLIER") ?? NaN);
  if (!Number.isNaN(override)) return override;
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10) ? 2 : 1;
}

interface ChatResponse {
  reasoningCapture?: ReasoningCaptureMetadata;
  id?: string;
  model?: string;
  system_fingerprint?: string;
  choices?: {
    message?: {
      content?: string;
      /** DeepSeek / GLM return the chain of thought here, separate from the answer. */
      reasoning_content?: string;
      tool_calls?: WireToolCall[];
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    /** DeepSeek's names for the cached / uncached split of the prompt. */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    /** Kimi and the OpenAI-shaped providers put the same figure here. */
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    /** OpenRouter reports actual USD cost, including cache reads and writes. */
    cost?: number;
    completion_tokens?: number;
    /** Reasoning tokens are billed as output but never appear in the visible text. */
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * How to ask for extra thinking, which differs per model family and fails loudly when wrong.
 *
 * Reasoning models reject `temperature` outright — axonhub returns 400 "`temperature` is
 * deprecated for this model". Callers catch per-call errors and substitute a default
 * forecast, so that 400 does not surface as a crash: one run silently defaulted
 * 123 of 200 cells to 0.5 and printed a complete results table in which every arm "lost" to
 * closed book. Hence temperature and thinking are mutually exclusive by construction.
 *
 * The two families want different shapes, verified by probe against axonhub:
 *   gpt-5.6-*      accepts `reasoning_effort: "high"`.
 *   claude-opus-5  REJECTS reasoning_effort — the gateway maps it to thinking.type "enabled",
 *                  and the model answers '"…enabled" is not supported for this model. Use
 *                  "…adaptive"'. It accepts `thinking: {type: "adaptive"}`.
 *
 * CAVEAT, stated because it limits what any result can claim: axonhub reports
 * reasoning_tokens = 0 for Claude under every form tried, so while "adaptive" is accepted,
 * there is no evidence here that a requested effort LEVEL is honoured for Claude. Treat
 * Claude runs as "thinking allowed", not "thinking set to high".
 */
/**
 * Reasoning models count their thinking against max_tokens, and an exhausted budget returns
 * an EMPTY string rather than an error.
 *
 * Measured on deepseek-v4-pro: max_tokens=32 with thinking on gives content === "" and
 * finish_reason === "length", the entire budget spent inside reasoning_content. GLM does the
 * same — glm-4.7 burned 633 of 641 completion tokens on reasoning for a one-word answer.
 * Providers therefore receive their documented model maximum when FABench knows it. Unknown
 * models omit the field and delegate to the provider default; a single harness-wide number is
 * unsafe because current model maxima range from 128K to more than 1M output tokens.
 */
/**
 * Collapse a server-sent-event stream back into the non-streaming response shape.
 *
 * Callers want one finished answer, not a token feed — streaming is enabled purely to keep
 * the connection alive (see the request body), so the difference is hidden here rather than
 * pushed onto every caller. The reassembled object keeps `finish_reason` and `usage`, which
 * downstream checks depend on: an empty answer is only diagnosable when the reason it ended
 * survives, and cost reporting reads usage.
 *
 * Usage arrives in its own final chunk that has an empty `choices` array, so the two must be
 * accumulated independently; treating the first empty-choices chunk as the end drops it.
 */
/** The first line of an SSE frame that starts with `data:`, without splitting the whole frame. */
export function firstDataLine(frame: string): string | undefined {
  let at = 0;
  if (!frame.startsWith("data:")) {
    const newline = frame.indexOf("\ndata:");
    if (newline < 0) return undefined;
    at = newline + 1;
  }
  const end = frame.indexOf("\n", at);
  return end < 0 ? frame.slice(at) : frame.slice(at, end);
}

async function readStream(
  res: Response,
  onProgress?: () => void,
  onTrace?: LlmRequest["onTrace"],
): Promise<ChatResponse> {
  let content = "";
  const capture = new ProviderReasoningCapture(onTrace);
  let captureMetadata: ReasoningCaptureMetadata;
  let reachedEnd = false;
  let finishReason: string | undefined;
  let usage: ChatResponse["usage"];
  let responseId: string | undefined;
  let responseModel: string | undefined;
  let systemFingerprint: string | undefined;
  // Tool calls stream as fragments keyed by index: the first delta carries id and name, and
  // the arguments arrive as a JSON string split across any number of later deltas. They must
  // be concatenated per index — treating each delta as a separate call yields one call per
  // token with unparseable arguments.
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let buf = "";
  const decoder = new TextDecoder();
  const reader = res.body!.getReader();
  try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { reachedEnd = true; break; }
    onProgress?.(); // bytes arrived — the call is alive, restart the idle clock
    buf += decoder.decode(value, { stream: true });
    // Frames are separated by a blank line; the trailing partial frame stays in the buffer.
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const line = firstDataLine(frame);
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let chunk: {
        id?: string;
        model?: string;
        system_fingerprint?: string;
        choices?: {
          delta?: {
            [key: string]: unknown;
            content?: string | {type?:string;text?:string;[key:string]:unknown}[];
            /** DeepSeek / GLM stream the chain of thought here, separate from the answer. */
            reasoning_content?: string;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          finish_reason?: string | null;
        }[];
        usage?: ChatResponse["usage"];
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // a malformed keepalive must not kill an otherwise good answer
      }
      if (chunk.usage) usage = chunk.usage;
      if (chunk.id) responseId = chunk.id;
      if (chunk.model) responseModel = chunk.model;
      if (chunk.system_fingerprint) systemFingerprint = chunk.system_fingerprint;
      const choice = chunk.choices?.[0];
      if (choice?.delta) capture.observe(choice.delta);
      if (typeof choice?.delta?.content === "string") content += choice.delta.content;
      else if (Array.isArray(choice?.delta?.content)) {
        for (const block of choice.delta.content)
          if (["text", "output_text"].includes(block.type ?? "") && typeof block.text === "string") content += block.text;
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = toolAcc.get(i) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        toolAcc.set(i, cur);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  }
  } finally {
    captureMetadata = capture.finish(reachedEnd && Boolean(finishReason));
  }
  if (!finishReason) throw new IncompleteProviderStream("Provider stream ended before a finish reason");
  const reasoning = capture.text;
  const tool_calls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id,
      function: { name: v.name, arguments: v.args },
    }));
  return {
    reasoningCapture: captureMetadata,
    ...(responseId ? { id: responseId } : {}),
    ...(responseModel ? { model: responseModel } : {}),
    ...(systemFingerprint ? { system_fingerprint: systemFingerprint } : {}),
    choices: [
      {
        message: {
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(tool_calls.length ? { tool_calls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  } as ChatResponse;
}

/**
 * Documented native output maxima for models used by FABench.
 *
 * This deliberately replaces the old blanket 32K harness ceiling. Reasoning tokens share the
 * completion budget, and DeepSeek V4 Flash exhausted 32K on a FutureX ranking question before
 * emitting any visible answer. The cap itself does not incur cost, but a model that actually
 * consumes it will be slower and more expensive, so every effective value remains in trace
 * metadata. Unknown models use the provider default instead of receiving a guessed number.
 */
const MODEL_MAX_OUTPUT_TOKENS = {
  deepseekV4: 384_000,
  glm5: 131_072,
  qwen38_27b: 131_072,
  kimiK3: 1_048_576,
} as const;

/**
 * Model-specific completion-token parameters. The model is required because providers such as
 * Bailian serve several families whose native maxima differ by almost an order of magnitude.
 */
export function completionTokenParams(
  providerId: string,
  model: string,
): { max_tokens?: number } {
  const provider = providerId.toLowerCase();
  const normalizedModel = model.toLowerCase();
  if (provider === "deepseek" && (normalizedModel === "deepseek-flash" || /^deepseek-v4(?:-|$)/.test(normalizedModel))) {
    return { max_tokens: MODEL_MAX_OUTPUT_TOKENS.deepseekV4 };
  }
  if (/^(?:zhipu\/)?glm-5\.(?:2|3)(?:-|$)/.test(normalizedModel)) {
    return { max_tokens: MODEL_MAX_OUTPUT_TOKENS.glm5 };
  }
  if (/^qwen3\.8-27b(?:-|$)/.test(normalizedModel)) {
    return { max_tokens: MODEL_MAX_OUTPUT_TOKENS.qwen38_27b };
  }
  if (
    /^(?:kimi\/)?kimi-k3(?:-|$)/.test(normalizedModel) ||
    (provider === "kimi" && normalizedModel === "k3")
  ) {
    return { max_tokens: MODEL_MAX_OUTPUT_TOKENS.kimiK3 };
  }
  return {};
}

export const CONTEXT_HEADROOM_POLICY = 'deepseek-reported-headroom-once-v1';

/** Use exact server token counts only after a rejected request; never truncate messages. */
export function reportedContextHeadroom(provider: string, status: number, body: string, requested: number | undefined) {
  if (provider !== 'deepseek' || status !== 400 || !Number.isSafeInteger(requested)) return undefined;
  let message: unknown;
  try { message = JSON.parse(body)?.error?.message; } catch { return undefined; }
  if (typeof message !== 'string') return undefined;
  const match = message.match(/maximum context length is (\d+) tokens\.\s*However, you requested (\d+) tokens\s*\((\d+) in the messages, (\d+) in the completion\)/);
  if (!match) return undefined;
  const [context, total, input, output] = match.slice(1).map(Number) as [number, number, number, number];
  if (![context, total, input, output].every(x => Number.isSafeInteger(x) && x > 0) ||
      total !== input + output || output !== requested || total <= context) return undefined;
  const remaining = context - input;
  if (remaining < 1 || remaining >= requested!) return undefined;
  return { max_tokens: remaining, context_tokens: context, input_tokens: input, rejected_max_tokens: output };
}

/** Provider extensions that OpenAI clients pass through with `extra_body`. */
export function providerRequestParams(
  providerId: string,
  model: string,
  hasTools: boolean,
): Record<string, unknown> {
  // Alibaba documents this as extra_body={tool_stream: true}; on the wire the OpenAI SDK
  // merges extra_body into the top-level JSON object. Without it GLM-5.2 answers normally
  // but never emits tool_calls, silently turning web-filter into closed book.
  if (
    providerId.toLowerCase() === "bailian" &&
    /^glm(?:-|$)/i.test(model) &&
    hasTools
  ) {
    return { tool_stream: true };
  }
  return {};
}

/**
 * Kimi's coding endpoint answers 200 for ids it does not host and echoes the requested id
 * back, serving a different model. Without this list we could publish results attributed to
 * a model we never called. Other providers reject unknown ids properly and are not listed.
 */
const KNOWN_MODELS: Record<string, readonly string[]> = {
  kimi: ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"],
};

/** Providers that reject `temperature` outright, or pin it to one legal value. */
const NO_TEMPERATURE = new Set(["kimi"]);

/**
 * Returning a tool-calling task's own reasoning to the provider that produced it.
 *
 * The providers FABench drives through this adapter define the agent loop the same way: keep
 * the assistant turn as returned, reasoning included, until the task ends. DeepSeek rejects a
 * continuation that omits `reasoning_content` (HTTP 400); GLM requires it for interleaved
 * thinking with tools; Kimi asks for every turn of the task to be kept; DashScope accepts the
 * field and ignores it unless `preserve_thinking` is set, which FABench does not send. No
 * retention switch (`preserve_thinking`, `clear_thinking`) is added, so each endpoint keeps
 * its documented default for earlier user turns.
 *
 * The scope is one task: a forecast question or one reviewed page. Tasks never share a
 * message list, so reasoning cannot cross questions or pages, and a final answer's reasoning
 * has no later turn to enter. Gateways that convert to signed thinking blocks or
 * `reasoning_details` (Anthropic through `custom`, OpenRouter) need structured provider
 * artifacts this adapter does not rebuild; they keep sending tool history without reasoning.
 */
export const REASONING_REPLAY_POLICY = Object.freeze({
  version: "same-task-tool-loop-v1",
  field: "reasoning_content",
  providers: Object.freeze(["deepseek", "glm", "kimi", "bailian"] as const),
});

/** The request field that carries an earlier turn's reasoning, or null when it is never sent. */
export function reasoningReplayField(providerId: string): string | null {
  return (REASONING_REPLAY_POLICY.providers as readonly string[]).includes(providerId.toLowerCase())
    ? REASONING_REPLAY_POLICY.field : null;
}

export function thinkingParams(
  providerId: string,
  model: string,
  effort: string | undefined,
  temperature: number,
): Record<string, unknown> {
  // Kimi pins temperature to exactly 1 and top_p to exactly 0.95; any other value is a 400.
  // Nothing here can be made deterministic, so the parameter is simply omitted.
  if (NO_TEMPERATURE.has(providerId))
    return effort ? { reasoning_effort: effort } : {};
  // Claude 5 rejects `temperature` UNCONDITIONALLY through this gateway, not merely when a
  // thinking parameter is present. The earlier fix assumed the conflict was between the two
  // and only dropped temperature when effort was set; the next run failed 200 of 200 calls
  // with the identical 400. Probing had missed it because the no-thinking probe also
  // happened to send no temperature.
  const isClaude = /claude/i.test(model);
  if (isClaude) return effort ? { thinking: { type: "adaptive" } } : {};
  if (!effort) return { temperature };
  // GLM and DeepSeek both accept reasoning_effort AND temperature together, unlike the
  // OpenAI/Claude reasoning models. Sending temperature alongside keeps the 3-sample median
  // meaningful; without it the samples would be near-identical.
  if (/^(glm|deepseek)/i.test(model))
    return { reasoning_effort: effort, temperature };
  return { reasoning_effort: effort };
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly id: string;
  readonly traceMetadata: Readonly<Record<string, unknown>>;
  private readonly admission: Pick<SharedRateLimiter, "acquire"> | undefined;
  private readonly resource: string;
  private readonly o: Required<
    Pick<OpenAiCompatibleOptions, "providerId" | "apiKey" | "baseUrl" | "model">
  > & {
    timeoutMs: number;
    temperature: number;
    priceInputPerM: number;
    priceCacheHitPerM: number;
    priceOutputPerM: number;
    pricingCurrency: string;
    usdCostKnown: boolean;
    pricingKnown: boolean;
    allowedModels?: readonly string[];
    thinking?: "disabled";
    maxOutputTokens?: number;
  };

  constructor(opts: OpenAiCompatibleOptions) {
    if (opts.thinking !== undefined && (opts.thinking !== "disabled" || !isNativeDeepSeekFlash(opts.providerId, opts.model, opts.baseUrl)))
      throw new Error("Explicit disabled thinking requires native DeepSeek Flash");
    if (opts.maxOutputTokens !== undefined && (opts.thinking !== "disabled" || !Number.isSafeInteger(opts.maxOutputTokens) || opts.maxOutputTokens < 1 || opts.maxOutputTokens > 384000))
      throw new Error("Explicit output limit requires disabled thinking and 1–384000 tokens");
    const pricingKnown =
      opts.pricingKnown ??
      (opts.priceInputPerM !== undefined && opts.priceOutputPerM !== undefined);
    const pricingCurrency = opts.pricingCurrency ?? "USD";
    this.o = {
      thinking: opts.thinking,
      maxOutputTokens: opts.maxOutputTokens,
      providerId: opts.providerId,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl.replace(/\/$/, ""),
      model: opts.model,
      timeoutMs: opts.timeoutMs ?? 180_000,
      temperature: opts.temperature ?? 0.3,
      priceInputPerM: opts.priceInputPerM ?? 0,
      priceCacheHitPerM: opts.priceCacheHitPerM ?? opts.priceInputPerM ?? 0,
      priceOutputPerM: opts.priceOutputPerM ?? 0,
      pricingCurrency,
      pricingKnown,
      allowedModels: opts.allowedModels ? Object.freeze([...opts.allowedModels]) : undefined,
      usdCostKnown:
        opts.usdCostKnown ?? (pricingKnown && pricingCurrency === "USD"),
    };
    this.id = `${this.o.providerId}:${this.o.model}`;
    this.admission = opts.admission ?? sharedRateLimiter();
    this.resource = apiResource(this.o.providerId, this.o.baseUrl, this.o.apiKey);
    const tokenParams = this.outputParams(this.o.model);
    this.traceMetadata = Object.freeze({
      protocol: "openai-compatible/chat-completions",
      transport_retry_policy: "headers-and-stream-three-attempts-v1",
      reasoning_retention_policy: REASONING_RETENTION_POLICY,
      reasoning_history_policy: this.o.thinking === "disabled" ? "local-only-v1" : REASONING_REPLAY_POLICY.version,
      reasoning_history_field: this.o.thinking === "disabled" ? null : reasoningReplayField(this.o.providerId),
      ...(this.o.thinking ? {thinking: {type: this.o.thinking}} : {}),
      api_admission_policy: this.admission ? RATE_POLICY : null,
      api_resource: this.admission ? this.resource : null,
      provider: this.o.providerId,
      base_url: this.o.baseUrl,
      model: this.o.model,
      ...(isNativeDeepSeekFlash(this.o.providerId, this.o.model, this.o.baseUrl) ? {
        documented_model_version: "DeepSeek-V4.1-Flash",
        model_version_source: DEEPSEEK_FLASH_DOCUMENTATION,
        pricing_schedule: "Published off-peak card; weekdays 01:00–04:00 and 06:00–10:00 UTC cost 2x; per-call card in transport trace",
      } : {}),
      ...(opts.credentialResource ? { credential_resource: opts.credentialResource } : {}),
      ...(this.o.allowedModels ? { allowed_models: this.o.allowedModels } : {}),
      timeout_ms: this.o.timeoutMs,
      temperature: this.o.temperature,
      max_tokens: tokenParams.max_tokens ?? null,
      ...(this.o.providerId === 'deepseek' ? { context_headroom_policy: CONTEXT_HEADROOM_POLICY } : {}),
      max_tokens_source:
        this.o.maxOutputTokens !== undefined ? "explicit-diagnostic" : tokenParams.max_tokens === undefined
          ? "provider-default"
          : "provider-model-maximum",
      stream: true,
      pricing: {
        known: this.o.pricingKnown,
        currency: this.o.pricingCurrency,
        ...(this.o.usdCostKnown !== this.o.pricingKnown
          ? { usd_cost_known: this.o.usdCostKnown }
          : {}),
        input_per_million_tokens: this.o.pricingKnown ? this.o.priceInputPerM : null,
        cached_input_per_million_tokens: this.o.pricingKnown
          ? this.o.priceCacheHitPerM
          : null,
        output_per_million_tokens: this.o.pricingKnown ? this.o.priceOutputPerM : null,
      },
    });
  }

  /** A new client keeps this opt-in condition out of callers using the original instance. */
  withThinkingDisabled(maxOutputTokens?: number): OpenAiCompatibleClient {
    return new OpenAiCompatibleClient({...this.o, admission: this.admission ?? undefined, thinking: "disabled", maxOutputTokens});
  }
  private outputParams(model: string): {max_tokens?: number} {
    return this.o.maxOutputTokens === undefined ? completionTokenParams(this.o.providerId, model) : {max_tokens: this.o.maxOutputTokens};
  }
  private generationParams(model: string, effort?: string): Record<string, unknown> {
    if (this.o.thinking === "disabled") {
      if (effort !== undefined || !isNativeDeepSeekFlash(this.o.providerId, model, this.o.baseUrl))
        throw new Error("Disabled thinking conflicts with effort or a non-Flash model override");
      return {temperature: this.o.temperature, thinking: {type: "disabled"}};
    }
    return thinkingParams(this.o.providerId, model, effort, this.o.temperature);
  }
  reasoningConfiguration(effort?: string): ReasoningConfiguration {
    const apiParameters = this.generationParams(this.o.model, effort);
    const thinking = apiParameters.thinking as { type?: unknown } | undefined;
    const sentEffort = apiParameters.reasoning_effort;
    const reasoningMode = typeof thinking?.type === "string" ? thinking.type : null;
    const thinkingEffort = typeof sentEffort === "string" ? sentEffort : null;
    return Object.freeze({
      reasoning_mode: reasoningMode,
      thinking_effort: thinkingEffort,
      requested_thinking_effort: effort ?? null,
      source: this.o.thinking === "disabled" ? "explicit" : effort
        ? thinkingEffort === effort
          ? "explicit"
          : "translated"
        : "provider-default",
      api_parameters: Object.freeze({ ...apiParameters }),
      history_replay: this.historyReplay(),
    });
  }

  private historyReplay(): Readonly<{ policy: string; field: string }> | null {
    const field = this.o.thinking === "disabled" ? null : reasoningReplayField(this.o.providerId);
    return field ? Object.freeze({ policy: REASONING_REPLAY_POLICY.version, field }) : null;
  }

  /**
   * POST with retries on transport failures and on the two server statuses worth retrying.
   *
   * A dropped connection used to kill a whole experiment cell. High-effort reasoning calls
   * run minutes long, so a single TCP reset — which "fetch failed" is — is common enough
   * that a 22-question × 5-arm run reliably lost a handful of cells; at 33% observed it
   * tripped the >5% failure guard and the run produced no table at all. Two retries with
   * backoff turn that into a delay instead of a lost run.
   *
   * This transport does not retry 4xx other than 429. A rejected parameter or an unknown model
   * fails identically on every attempt, and retrying it hides the error behind a delay —
   * exactly how the `temperature` rejection went unnoticed for two full runs. complete()
   * separately permits one explicit correction of server-reported context headroom.
   *
   * The deadline is IDLE time, not total time. `AbortSignal.timeout(n)` counts from the
   * moment the request is sent and fires whether or not data is flowing, which makes it
   * useless for a streamed reasoning call: turning on streaming stopped the server hanging
   * up, and the next run still lost 27 of 88 cells because our own wall-clock deadline
   * killed calls that were streaming normally. What actually indicates a dead call is
   * silence, so the timer is restarted by readStream on every chunk that arrives and only a
   * genuinely stalled connection trips it.
   *
   * The controller is returned alongside the response because the deadline must keep being
   * enforced while the body is read — a signal that stops mattering once headers arrive
   * would let a stalled body hang forever.
   */
  private async fetchWithRetry(
    init: RequestInit,
    attempts = 3,
    onTrace?: LlmRequest["onTrace"],
  ): Promise<{ res: Response; data?: ChatResponse; done: (error?:unknown) => void }> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      init.signal?.throwIfAborted();
      if (i > 0) {
        const delayMs = 2000 * 2 ** (i - 1);
        onTrace?.({ type: "http_retry_wait", data: { attempt: i + 1, delay_ms: delayMs } });
        await abortablePause(delayMs,undefined,{signal:init.signal??undefined});
      }
      // Waiting for a shared slot is not a network timeout and must not consume one.
      const span=timingSpan('model.http');span.queued();
      let permit;
      try{permit=await this.admission?.acquire(this.resource,onTrace,init.signal??undefined);}catch(error){span.end(error);throw error;}
      span.admitted();span.start();
      const ctrl = new AbortController();
      const timer = setTimeout(
        () => ctrl.abort(new Error("idle timeout")),
        this.o.timeoutMs,
      );
      // Restart the same timer on every chunk; a fresh timer per chunk was needless churn.
      const keepAlive = () => { timer.refresh(); };
      let successfulResponse = false;
      let finished = false;
      const done = (error?:unknown) => { if (finished) return; finished = true; clearTimeout(timer); permit?.release(successfulResponse&&!error); span.end(error??(successfulResponse?undefined:new Error("Model request failed"))); };
      onTrace?.({
        type: "http_attempt_started",
        data: {
          attempt: i + 1,
          max_attempts: attempts,
          endpoint: `${this.o.baseUrl}/chat/completions`,
        },
      });
      let phase = "response-headers";
      try {
        const res = await fetch(`${this.o.baseUrl}/chat/completions`, {
          ...init,
          signal: AbortSignal.any([ctrl.signal,...(permit?.signal?[permit.signal]:[]),...(init.signal?[init.signal]:[])]),
        });
        onTrace?.({
          type: "http_response_headers",
          data: {
            attempt: i + 1,
            status: res.status,
            request_id:
              res.headers.get("x-request-id") ??
              res.headers.get("request-id") ??
              undefined,
          },
        });
        if (res.status === 429 || res.status >= 500) {
          const body = await res.text().catch(() => "");
          const classified = classifyProviderHttpError(
            this.o.providerId,
            res.status,
            body,
          );
          last = classified;
          if (classified.category === "rate_limited") permit?.limited(res.headers.get("retry-after"));
          done();
          onTrace?.({
            type: "http_attempt_failed",
            data: {
              attempt: i + 1,
              retryable: classified.retryable,
              status: res.status,
              provider_error_category: classified.category,
              provider_error_code: classified.providerCode,
              body: body.slice(0, 1_000),
              error: classified.message,
            },
          });
          if (!classified.retryable) throw classified;
          continue;
        }
        successfulResponse = res.ok;
        if (!res.ok) return { res, done };
        // Receiving headers does not finish a streamed request. A later socket
        // reset must use this same bounded retry budget and release its permit.
        // readStream archives partial reasoning locally before it throws; only
        // a completed attempt can supply text or tool calls to the caller.
        phase = "response-body";
        const data = await readStream(res, keepAlive, onTrace);
        done();
        return { res, data, done };
      } catch (e) {
        done(e);
        init.signal?.throwIfAborted();
        if (isNonRetryableProviderApiError(e)) throw e;
        // Only recognized transport failures may trigger an alternative provider.
        // Programming errors, output validation and caller cancellation must not.
        last = e instanceof IncompleteProviderStream || e instanceof TypeError || ctrl.signal.aborted
          ? new ProviderTransportError(this.o.providerId, i + 1, phase, e) : e;
        onTrace?.({
          type: "http_attempt_failed",
          data: {
            attempt: i + 1,
            phase,
            retryable: true,
            error: e instanceof Error
              ? { name: e.name, message: e.message }
              : { name: "NonErrorThrown", message: String(e) },
          },
        });
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const wanted = req.model ?? this.o.model;
    const flashPrice = isNativeDeepSeekFlash(this.o.providerId, wanted, this.o.baseUrl)
      ? deepseekFlashPriceCard(new Date()) : null;
    if (this.o.allowedModels && !this.o.allowedModels.includes(wanted)) {
      throw new Error(`${this.o.providerId}: model override is outside this client's credential scope; create a new client for the requested model`);
    }
    const allowed = KNOWN_MODELS[this.o.providerId];
    if (allowed && !allowed.includes(wanted)) {
      throw new Error(
        `${this.o.providerId} does not host "${wanted}" — it would answer 200 with a different model. ` +
          `Available: ${allowed.join(", ")}`,
      );
    }
    // A caller driving a tool loop owns the whole history and passes it verbatim; providers
    // reject a tool result that does not directly follow the assistant turn that asked for
    // it, so the exchange cannot be reconstructed from a single prompt string. Each assistant
    // turn carries its own reasoning back where the provider reads it (REASONING_REPLAY_POLICY).
    const replayField = this.o.thinking === "disabled" ? null : reasoningReplayField(this.o.providerId);
    const messages: Record<string, unknown>[] = req.messages
      ? req.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(replayField && m.role === "assistant" && typeof m.reasoning === "string"
            ? { [replayField]: m.reasoning }
            : {}),
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((t) => ({
                  id: t.id,
                  type: "function",
                  function: { name: t.name, arguments: JSON.stringify(t.args) },
                })),
              }
            : {}),
          ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        }))
      : [
          ...(req.system ? [{ role: "system", content: req.system }] : []),
          { role: "user", content: req.prompt },
        ];

    const tokenParams = this.outputParams(wanted);
    const generationParams = this.generationParams(wanted, req.effort);
    const providerParams = providerRequestParams(
      this.o.providerId,
      wanted,
      Boolean(req.tools?.length),
    );
    // OpenRouter forwards automatic caching for Claude across its supported routes.
    // Keep the complete message/tool payload unchanged; the provider advances the cache
    // boundary as the conversation grows, including tool results and the final turn.
    // Other vendors retain their native implicit caching; do not send them Claude fields.
    const cacheControl = this.o.providerId === "openrouter" && /^anthropic\/claude-/i.test(wanted)
      ? { type: "ephemeral" as const } : undefined;
    const requestBody = {
      ...(cacheControl ? { cache_control: cacheControl } : {}),
      model: req.model ?? this.o.model,
      messages,
      ...tokenParams,
      // Streaming is not a nicety here, it is what makes high-effort calls survive.
      // A reasoning model can think for many minutes before emitting its first visible
      // token, and a non-streaming request that sends nothing for that long gets killed:
      // a 22-question run at effort=high lost 17 of 88 cells to "terminated" (server
      // closed the connection) and "aborted due to timeout". Streaming keeps bytes moving,
      // so the same call completes. include_usage asks for the token counts that would
      // otherwise only appear in a non-streamed body — without it, cost silently reads 0.
      stream: true,
      stream_options: { include_usage: true },
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
            tool_choice: "auto",
          }
        : {}),
      ...generationParams,
      ...providerParams,
    };
    req.onTrace?.({
      type: "http_request_prepared",
      data: {
        model: requestBody.model,
        message_count: messages.length,
        tools: req.tools?.map((t) => t.name) ?? [],
        max_tokens: tokenParams.max_tokens ?? null,
        ...(this.o.providerId === 'deepseek' ? { context_headroom_policy: CONTEXT_HEADROOM_POLICY } : {}),
        max_tokens_source:
          this.o.maxOutputTokens !== undefined ? "explicit-diagnostic" : tokenParams.max_tokens === undefined
            ? "provider-default"
            : "provider-model-maximum",
        stream: true,
        generation_parameters: generationParams,
        provider_parameters: providerParams,
        prompt_cache_control: cacheControl ?? null,
        ...(flashPrice ? { effective_price_card: flashPrice } : {}),
      },
    });
    let response: Awaited<ReturnType<OpenAiCompatibleClient['fetchWithRetry']>>;
    for (let repair = 0; ; repair++) {
      response = await this.fetchWithRetry({
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.o.apiKey}`,
        "Content-Type": "application/json",
      },
      // Reasoning models reject `temperature` outright — axonhub returns
      // 400 "`temperature` is deprecated for this model" for both claude-opus-5 and
      // gpt-5.6-sol when reasoning_effort is set. That failure is easy to miss because
      // callers catch per-call errors and substitute a default forecast: a first run of the
      // run silently defaulted 123 of 200 cells to 0.5 and produced a full
      // results table in which every arm "lost" to closed book. So the two are mutually
      // exclusive by construction here, not by convention.
      body: JSON.stringify(requestBody),
      signal:req.signal,
    }, 3, req.onTrace);

      if (response.res.ok) break;
      response.done();
      const text = await response.res.text().catch(() => "");
      req.onTrace?.({
        type: "http_error_response",
        data: { status: response.res.status, body: text },
      });
      const headroom = repair === 0
        ? reportedContextHeadroom(this.o.providerId, response.res.status, text, requestBody.max_tokens)
        : undefined;
      if (!headroom) throw classifyProviderHttpError(this.o.providerId, response.res.status, text);
      requestBody.max_tokens = headroom.max_tokens;
      req.onTrace?.({ type: 'http_context_headroom_retry', data: {
        policy: CONTEXT_HEADROOM_POLICY, ...headroom, message_count: messages.length,
        context_preserved: true, generation_parameters_preserved: true,
      } });
    }
    const { res, data } = response;
    if (!data) throw new Error("Successful response has no completed stream");
    const text = data.choices?.[0]?.message?.content ?? "";
    const reasoning = data.choices?.[0]?.message?.reasoning_content ?? "";
    const finishReason = data.choices?.[0]?.finish_reason;
    const toolCalls = (data.choices?.[0]?.message?.tool_calls ?? []).map(
      (t) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(t.function?.arguments || "{}") as Record<
            string,
            unknown
          >;
        } catch {
          // Models do occasionally emit malformed argument JSON. An empty object lets the
          // caller reply "bad arguments" as a tool result and let the model retry, which is
          // recoverable; throwing here would lose the whole question.
        }
        return { id: t.id ?? "", name: t.function?.name ?? "", args };
      },
    );
    // An empty body with finish_reason "length" means the reasoning ate the whole budget.
    // Silence here becomes an unparseable probability that the caller defaults to 0.5, so
    // it is raised as an error where it is still identifiable. A turn that only requested
    // tools is legitimately empty, so it must not trip this.
    if (!text.trim() && !toolCalls.length && finishReason === "length") {
      throw new Error(
        tokenParams.max_tokens === undefined
          ? `${this.o.providerId}: empty content, finish_reason=length — provider output limit reached`
          : `${this.o.providerId}: empty content, finish_reason=length — effective output limit ${requestBody.max_tokens} tokens was exhausted`,
      );
    }
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    // Reasoning tokens are billed as output but are not in the visible text; without
    // this the cost of a high-effort run is silently under-reported.
    // Reasoning tokens are billed as output but are not in the visible text; without
    // counting them, a high-effort run under-reports its own cost.
    const reasoningTokens =
      data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    // Charge cached input at the cache price, which is not a rounding detail: DeepSeek bills
    // a cache hit at $0.003625/M against $0.435/M for a miss — 120× — and the agentic tool
    // loop is the most cache-friendly shape there is, because every turn resends the whole
    // conversation with only the newest tool result appended. Measured directly: an
    // identical second call reported 1,280 of 1,290 prompt tokens as cache hits. Charging
    // every input token at the miss price therefore overstated the bill substantially, and
    // that overstatement pointed the wrong way on the one decision it fed — whether the
    // multi-call arms are too expensive to run.
    //
    // Missing telemetry is unknown, not evidence of a cache miss. Only cost estimation
    // falls back to zero known hits; preserve absence in the completion and trace.
    const reportedCachedIn = data.usage?.prompt_cache_hit_tokens ??
      data.usage?.prompt_tokens_details?.cached_tokens;
    const cacheWriteIn = data.usage?.prompt_tokens_details?.cache_write_tokens;
    const cachedIn = reportedCachedIn ?? 0;
    const reportedCost = this.o.providerId === "openrouter" &&
      typeof data.usage?.cost === "number" && Number.isFinite(data.usage.cost) && data.usage.cost >= 0
      ? data.usage.cost : undefined;
    req.onTrace?.({type: "provider_usage", data: {
      input_tokens: inputTokens, output_tokens: outputTokens,
      cached_input_tokens: reportedCachedIn ?? null,
      cache_write_input_tokens: cacheWriteIn ?? null,
      reported_cost_usd: reportedCost ?? null,
      native_usage: data.usage ?? null,
    }});
    const freshIn = Math.max(0, inputTokens - cachedIn);
    // Native DeepSeek completion_tokens already includes reasoning; do not bill it twice.
    const costUsd = reportedCost ?? (flashPrice && this.o.usdCostKnown
      ? (freshIn * flashPrice.input_per_million_tokens +
          cachedIn * flashPrice.cached_input_per_million_tokens +
          outputTokens * flashPrice.output_per_million_tokens) / 1e6
      : this.o.usdCostKnown
        ? (freshIn / 1e6) * this.o.priceInputPerM +
          (cachedIn / 1e6) * this.o.priceCacheHitPerM +
          ((outputTokens + reasoningTokens) / 1e6) * this.o.priceOutputPerM
        : 0);

    return {
      text,
      ...(reasoning ? { reasoning } : {}),
      reasoningCapture: data.reasoningCapture,
      costUsd,
      inputTokens,
      outputTokens,
      cachedInputTokens: reportedCachedIn,
      cacheWriteInputTokens: cacheWriteIn,
      reasoningTokens,
      provider: {
        requestId:
          res.headers.get("x-request-id") ??
          res.headers.get("request-id") ??
          undefined,
        responseId: data.id,
        model: data.model ?? wanted,
        systemFingerprint: data.system_fingerprint,
      },
      finishReason,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }
}
