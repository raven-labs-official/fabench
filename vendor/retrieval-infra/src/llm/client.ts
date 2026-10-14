/**
 * LlmClient — the swappable seam.
 *
 * The benchmark's `ForecastingPredictor` talks to a model ONLY through this
 * interface. To plug in your own agent / harness / model, implement `LlmClient`
 * and pass it to the predictor — nothing else changes. The default
 * implementations speak the OpenAI-compatible HTTP protocol, but
 * that is just one implementation of this contract.
 */

import type { ReasoningCaptureMetadata } from "./reasoning-capture.js";

export interface LlmCompletion {
  /** The model's response text. */
  text: string;
  /**
   * The model's chain of thought, when the provider returns one separately from the answer
   * (`reasoning_content` on DeepSeek and GLM). Dropped until 2026-08-22, which meant the
   * archive held what the model concluded but not how it got there — the thing an evidence
   * audit is actually about. Empty for providers that do not expose it.
   */
  reasoning?: string;
  /** Provider-exposed artifacts and absence status; native fragments live in transport traces. */
  reasoningCapture?: ReasoningCaptureMetadata;
  /** USD cost of this single call (0 if the backend does not report cost). */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from a provider cache, when reported. */
  cachedInputTokens?: number;
  /** Input tokens written to a provider cache, when reported; included in inputTokens. */
  cacheWriteInputTokens?: number;
  /** Hidden reasoning tokens, when the provider reports them separately. */
  reasoningTokens?: number;
  /** Provider response identity needed to audit model/version drift across runs. */
  provider?: {
    requestId?: string;
    responseId?: string;
    model?: string;
    systemFingerprint?: string;
  };
  /**
   * Tools the model asked to run, empty when it answered directly.
   *
   * Present only when the caller supplied `tools`. The caller executes each one and sends
   * the results back as `role: "tool"` messages on the next turn; nothing here executes
   * anything itself.
   */
  toolCalls?: ToolCall[];
  /** Why generation stopped — "tool_calls" means the model is waiting for results. */
  finishReason?: string;
}

/** One tool invocation requested by the model. */
export interface ToolCall {
  /** Provider-assigned id; must be echoed back on the matching tool result. */
  id: string;
  name: string;
  /** Parsed arguments. Malformed JSON from the model arrives as {} rather than throwing. */
  args: Record<string, unknown>;
}

/** A tool offered to the model, in OpenAI function-calling shape. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

/**
 * One turn of a conversation, so a caller can drive a multi-step tool loop.
 *
 * `LlmRequest.prompt` covers the single-shot case and stays the common path. A loop needs
 * to replay the whole exchange — the model's own tool-call turn included, because providers
 * reject a tool result that does not follow the assistant message that requested it.
 */
export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant turns only: the calls this turn requested. */
  toolCalls?: ToolCall[];
  /** tool turns only: which call this is answering. */
  toolCallId?: string;
  /**
   * assistant turns only: the reasoning text the same provider returned with this turn.
   *
   * Tool-calling providers read their own earlier reasoning while a task continues: DeepSeek
   * rejects a continuation without it, and GLM and Kimi document that interleaved thinking
   * must be returned with the tool results. The adapter sends it back only in that same
   * task and only in the field its provider defines (see `REASONING_REPLAY_POLICY`); for
   * other providers it remains in the local archive alone. A task never receives another
   * task's reasoning, because every task builds its own message list.
   */
  reasoning?: string;
}

export interface LlmRequest {
  signal?:AbortSignal;
  /** System prompt (persona / instructions). */
  system?: string;
  /** User prompt. */
  prompt: string;
  /** Optional per-call model override; falls back to the client's default. */
  model?: string;
  /**
   * Provider-native reasoning budget for models that expose one (for example `low` through
   * `max`). The accepted values are intentionally not normalised across vendors.
   *
   * Passed through as OpenAI's `reasoning_effort`. Providers that do not understand it
   * ignore it rather than erroring — verified against axonhub for gpt-5.6-sol and
   * claude-opus-5, both of which accept it and report reasoning_tokens back.
   *
   * Worth setting on forecasting calls specifically: the failure we measured is a model
   * naming a historical base rate early and then barely moving off it, which is exactly
   * the shape of not thinking hard enough about the specific situation.
   */
  effort?: string;
  /**
   * Full conversation, used instead of `prompt` when driving a tool loop.
   *
   * When present, `system` and `prompt` are ignored — the caller owns the whole history,
   * because a tool loop must replay prior turns verbatim for the provider to accept the
   * next one.
   */
  messages?: LlmMessage[];
  /** Tools the model may call. Omit for a plain completion. */
  tools?: ToolSpec[];
  /**
   * Sanitised transport lifecycle events (attempts, HTTP status, retries).  No auth headers
   * are ever emitted.  A trajectory recorder uses this to distinguish model behaviour from
   * provider/network failure without coupling the HTTP client to a particular archive.
   */
  onTrace?: (event: LlmTraceEvent) => void;
}

export interface LlmTraceEvent {
  type: string;
  data?: unknown;
}

/**
 * Provider-native reasoning settings for one request.
 *
 * There is deliberately no shared enum for effort. Providers expose different values
 * (`low` through `max`, or other vendor-specific strings), and some expose no effort knob at
 * all. Null means FABench did not explicitly send that setting; it must not be rewritten as a
 * guessed provider default.
 */
export interface ReasoningConfiguration {
  reasoning_mode: string | null;
  thinking_effort: string | null;
  requested_thinking_effort: string | null;
  source: "explicit" | "translated" | "provider-default";
  /** Exact non-secret request fields produced by the provider adapter. */
  api_parameters: Readonly<Record<string, unknown>>;
  /**
   * How earlier reasoning of the same tool-calling task is returned to the provider, or null
   * when the adapter never sends it. Part of the request shape, so it belongs in condition
   * identity alongside the effort settings.
   */
  history_replay?: Readonly<{ policy: string; field: string }> | null;
}

export interface LlmClient {
  /** Stable identifier, e.g. "claude-cli:sonnet". Used in predictor ids and logs. */
  readonly id: string;
  /** Non-secret generation and endpoint configuration captured in a run/agent manifest. */
  readonly traceMetadata?: Readonly<Record<string, unknown>>;
  /** Describe the exact reasoning request this client will produce for an optional effort. */
  reasoningConfiguration?(effort?: string): ReasoningConfiguration;
  /** Bind a multi-turn tool conversation to one provider after its first completion. */
  startConversation?(): LlmClient;
  complete(req: LlmRequest): Promise<LlmCompletion>;
}
