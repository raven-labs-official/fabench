/**
 * Keep a tool-loop conversation under a provider's hard input limit.
 *
 * The frozen arm returns whole articles, so a question that reads enough of them eventually
 * sends a request the provider refuses outright. That is not a rate limit and retrying cannot
 * fix it; the cell simply dies. Measured on the July-254 matrix:
 *
 *   - bailian qwen3.6-35b-a3b: `InternalError.Algo.InvalidParameter: Range of input length
 *     should be [1, 229376]` killed 37 of 241 frozen cells.
 *   - kimi k3: `Your request exceeded model token limit: 1048576 (requested: 1147175)`.
 *   - deepseek: the same 1,048,576 ceiling, recorded against J-WEA-06 and four others.
 *
 * The limits differ by an order of magnitude between models, so a single constant would either
 * cripple the large-context models or fail to protect the small ones. Hence a per-run setting.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never shortens the system prompt, the question, or an
 * assistant turn. Only tool results are dropped, oldest first, and a dropped result is REPLACED
 * BY A NOTICE rather than deleted silently — the same principle `fetchChars` documents: a tool
 * that returns a fragment while the model believes it holds the whole thing makes the model
 * reason from a fragment it cannot detect. Here the model is told what it lost and can fetch
 * again if it still needs the text.
 *
 * If dropping every tool result still does not fit, this reports `fits: false` and changes
 * nothing further. The caller must then let the provider reject the request so the cell fails
 * and is counted, because a question whose own text exceeds the window is not a question this
 * model can answer, and quietly truncating it would put an unanswerable cell in the results
 * table as if it were a forecast.
 *
 * ENABLING THIS CHANGES THE PREDICTION SETTING. The model sees different bytes, so runs with a
 * cap belong to their own segment (docs/agent-handoff.md §3.4) and carry their own condition_id.
 * It is off by default so existing conditions stay byte-identical.
 */
import type { LlmMessage } from "../llm/client.js";

/**
 * Characters per token used to size a request before sending it.
 *
 * No provider here exposes a tokenizer over HTTP, and shipping one per vendor would pin us to
 * their vocabularies. Four characters per token is the usual English approximation; CJK runs
 * denser, so the estimate UNDERCOUNTS on Chinese text, which is why `SAFETY_FRACTION` leaves
 * headroom rather than aiming at the limit exactly.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Fraction of the declared limit we actually target.
 *
 * The estimate above is approximate in the dangerous direction and the provider counts the
 * tool schemas and its own scaffolding too. Filling 90% of the window and being wrong by 5%
 * still fits; filling 100% and being wrong by 5% is the hard failure this module exists to
 * prevent.
 */
export const SAFETY_FRACTION = 0.9;

/** Stand-in left where a tool result was removed. Visible to the model on purpose. */
export const DROPPED_NOTICE =
  "[removed to stay within this model's input limit; call the tool again if you still need it]";

export interface ContextCapResult {
  /** The conversation to send. Same array contents when nothing had to be dropped. */
  messages: LlmMessage[];
  /** Tool results replaced by `DROPPED_NOTICE`. */
  dropped: number;
  /** Estimated tokens before trimming. */
  estimatedBefore: number;
  /** Estimated tokens after trimming. */
  estimatedAfter: number;
  /** False when even a fully trimmed conversation is still over budget. */
  fits: boolean;
}

/** Approximate tokens for one message, including the role and tool-call envelope. */
function messageChars(message: LlmMessage): number {
  let chars = message.role.length + message.content.length;
  if (message.reasoning) chars += message.reasoning.length;
  if (message.toolCallId) chars += message.toolCallId.length;
  if (message.toolCalls?.length) chars += JSON.stringify(message.toolCalls).length;
  // Each message also costs a few tokens of delimiters on every provider's wire format.
  return chars + 16;
}

/** Estimated tokens for a whole conversation. */
export function estimateTokens(messages: readonly LlmMessage[]): number {
  let chars = 0;
  for (const message of messages) chars += messageChars(message);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Trim `messages` until the estimate fits `maxInputTokens * SAFETY_FRACTION`.
 *
 * `maxInputTokens` of 0 or undefined means no cap and returns the input untouched, which is
 * what every pre-existing condition uses.
 */
export function capConversation(
  messages: LlmMessage[],
  maxInputTokens: number | undefined,
): ContextCapResult {
  const estimatedBefore = estimateTokens(messages);
  if (!maxInputTokens || maxInputTokens <= 0)
    return { messages, dropped: 0, estimatedBefore, estimatedAfter: estimatedBefore, fits: true };

  const budget = Math.floor(maxInputTokens * SAFETY_FRACTION);
  if (estimatedBefore <= budget)
    return { messages, dropped: 0, estimatedBefore, estimatedAfter: estimatedBefore, fits: true };

  // Copy before mutating: the caller keeps the full history for the trace, and the next turn
  // is built from its own untrimmed list so one tight turn cannot permanently erase evidence.
  const trimmed = messages.slice();
  let estimatedAfter = estimatedBefore;
  let dropped = 0;

  for (let i = 0; i < trimmed.length && estimatedAfter > budget; i++) {
    const message = trimmed[i];
    if (!message || message.role !== "tool" || message.content === DROPPED_NOTICE) continue;
    const replacement: LlmMessage = { ...message, content: DROPPED_NOTICE };
    estimatedAfter -= Math.ceil((messageChars(message) - messageChars(replacement)) / CHARS_PER_TOKEN);
    trimmed[i] = replacement;
    dropped++;
  }

  return { messages: trimmed, dropped, estimatedBefore, estimatedAfter, fits: estimatedAfter <= budget };
}
