import type { LlmClient, LlmCompletion, LlmRequest, LlmTraceEvent, ReasoningConfiguration } from "./client.js";
import { ProviderApiError, ProviderTransportError } from "./openai-compatible.js";

/**
 * One review model with a second one behind it.
 *
 * The primary is preferred for every request. A request moves to the fallback only when the
 * primary cannot take it: its shared-admission queue did not admit the request within
 * `admissionWaitMs`, or the provider answered with a rate limit, a server error or an
 * exhausted balance, or its bounded transport retries were exhausted before a completed reply.
 * A classified rejection spills over before retrying the primary. Ordinary failures (authentication,
 * rejected parameters, malformed output) surface unchanged, and a caller's cancellation is
 * never turned into a fallback call.
 *
 * Which client answered is visible in the completion's provider metadata and in the
 * `fallback_client_used` trace event, so receipts can be attributed per call.
 */
export const FALLBACK_CLIENT_POLICY = Object.freeze({
  version: "primary-admission-spillover-v4",
  conversation_policy: "bind-after-first-completion-v1",
  default_admission_wait_ms: 3_000,
  fallback_categories: ["rate_limited", "server_error", "insufficient_balance"] as const,
  fallback_on_exhausted_transport: true,
});

export interface FallbackClientOptions {
  /** Longest wait for the primary's shared-admission slot before the request spills over. */
  admissionWaitMs?: number;
}

// Preparing the body precedes admission and must not cancel the queue deadline.
const COMMITTED_EVENTS = new Set(["shared_rate_admitted", "http_attempt_started"]);

function pricingKnown(client: LlmClient): boolean {
  const pricing = client.traceMetadata?.pricing as { known?: unknown; usd_cost_known?: unknown } | undefined;
  return pricing?.usd_cost_known === undefined ? pricing?.known === true : pricing.usd_cost_known === true;
}

export class FallbackLlmClient implements LlmClient {
  readonly id: string;
  readonly traceMetadata: Readonly<Record<string, unknown>>;
  readonly counts = { primary: 0, fallback_after_wait: 0, fallback_after_error: 0 };
  private readonly admissionWaitMs: number;

  constructor(private readonly primary: LlmClient, private readonly fallback: LlmClient, options: FallbackClientOptions = {}) {
    if (primary.id === fallback.id) throw new Error("fallback client must differ from the primary");
    this.admissionWaitMs = options.admissionWaitMs ?? FALLBACK_CLIENT_POLICY.default_admission_wait_ms;
    if (!Number.isSafeInteger(this.admissionWaitMs) || this.admissionWaitMs < 100) throw new Error("admission wait must be at least 100 ms");
    this.id = `${primary.id}→${fallback.id}`;
    this.traceMetadata = Object.freeze({
      policy: FALLBACK_CLIENT_POLICY.version,
      conversation_policy: FALLBACK_CLIENT_POLICY.conversation_policy,
      admission_wait_ms: this.admissionWaitMs,
      fallback_categories: [...FALLBACK_CLIENT_POLICY.fallback_categories],
      fallback_on_exhausted_transport: FALLBACK_CLIENT_POLICY.fallback_on_exhausted_transport,
      primary: { id: primary.id, ...(primary.traceMetadata ?? {}) },
      fallback: { id: fallback.id, ...(fallback.traceMetadata ?? {}) },
      pricing: { known: pricingKnown(primary) && pricingKnown(fallback), basis: "known only when both clients price their usage" },
    });
  }

  /** The primary's request shape defines the configuration; the fallback's is recorded beside it. */
  reasoningConfiguration(effort?: string): ReasoningConfiguration {
    const primary = this.primary.reasoningConfiguration?.(effort);
    const fallback = this.fallback.reasoningConfiguration?.(effort) ?? null;
    const base: ReasoningConfiguration = primary ?? {
      reasoning_mode: null, thinking_effort: null, requested_thinking_effort: effort ?? null, source: "provider-default", api_parameters: {},
    };
    return { ...base, api_parameters: { ...base.api_parameters, fallback_reasoning: fallback } };
  }

  /** Tool-call histories are provider-specific. Each page chooses once; new pages still
   * prefer the primary. Later turns use that provider's ordinary retry/admission policy. */
  startConversation(): LlmClient {
    let selected: LlmClient | undefined;
    let role: "primary" | "fallback" = "primary";
    return {
      id: this.id,
      traceMetadata: this.traceMetadata,
      reasoningConfiguration: effort => this.reasoningConfiguration(effort),
      complete: async req => {
        if (!selected) {
          const response = await this.complete({ ...req, onTrace: event => {
            if (event.type === "fallback_client_used") role = "fallback";
            req.onTrace?.(event);
          } });
          selected = role === "primary" ? this.primary : this.fallback;
          req.onTrace?.({ type: "fallback_conversation_bound", data: { model: selected.id, role, policy: FALLBACK_CLIENT_POLICY.conversation_policy } });
          return response;
        }
        req.onTrace?.({ type: "fallback_conversation_continued", data: { model: selected.id, role } });
        return selected.complete({ ...req, onTrace: event => req.onTrace?.({ type: event.type, data: {
          fallback_role: role, ...(typeof event.data === "object" && event.data !== null ? event.data as Record<string, unknown> : { value: event.data }),
        } }) });
      },
    };
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const upstream = req.signal;
    upstream?.throwIfAborted();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(upstream?.reason);
    upstream?.addEventListener("abort", forwardAbort, { once: true });
    let committed = false;
    let spilled = false;
    let rejectedCategory: string | undefined;
    const timer = setTimeout(() => {
      if (committed) return;
      spilled = true;
      controller.abort(new Error("primary admission wait exceeded"));
    }, this.admissionWaitMs);
    const onTrace = (event: LlmTraceEvent) => {
      if (COMMITTED_EVENTS.has(event.type)) { committed = true; clearTimeout(timer); }
      req.onTrace?.({ type: event.type, data: { fallback_role: "primary", ...(typeof event.data === "object" && event.data !== null ? event.data as Record<string, unknown> : { value: event.data }) } });
      if (event.type === "http_attempt_failed" && typeof event.data === "object" && event.data !== null) {
        const category = (event.data as Record<string, unknown>).provider_error_category;
        if (typeof category === "string" && (FALLBACK_CLIENT_POLICY.fallback_categories as readonly string[]).includes(category)) {
          rejectedCategory = category;
          controller.abort(new Error(`primary provider rejected request: ${category}`));
        }
      }
    };
    try {
      const completion = await this.primary.complete({ ...req, signal: controller.signal, onTrace });
      this.counts.primary++;
      return completion;
    } catch (error) {
      if (upstream?.aborted) throw error;
      const afterWait = spilled && !committed;
      const providerFailure = error instanceof ProviderApiError
        && (FALLBACK_CLIENT_POLICY.fallback_categories as readonly string[]).includes(error.category);
      const transportFailure = error instanceof ProviderTransportError;
      if (!afterWait && !providerFailure && !rejectedCategory && !transportFailure) throw error;
      const reason = afterWait ? "primary_admission_wait_exceeded" : transportFailure
        ? "primary_transport_retries_exhausted" : `primary_${rejectedCategory ?? (error as ProviderApiError).category}`;
      if (afterWait) this.counts.fallback_after_wait++; else this.counts.fallback_after_error++;
      req.onTrace?.({ type: "fallback_client_used", data: { primary: this.primary.id, fallback: this.fallback.id, reason, admission_wait_ms: this.admissionWaitMs } });
      return this.fallback.complete({ ...req, onTrace: event => req.onTrace?.({ type: event.type, data: { fallback_role: "fallback", ...(typeof event.data === "object" && event.data !== null ? event.data as Record<string, unknown> : { value: event.data }) } }) });
    } finally {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", forwardAbort);
    }
  }
}
