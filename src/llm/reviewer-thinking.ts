import type { LlmClient } from './client.js';
import { OpenAiCompatibleClient } from './openai-compatible.js';
import { isNativeDeepSeekFlash } from '../../vendor/retrieval-infra/src/llm/deepseek-flash.js';

export type ReviewerThinking = 'enabled' | 'disabled';
export type ReviewerEffort = 'low' | 'high' | 'max';

export function validateShadowReviewEffort(value: string | undefined, config: {
  compare: string; profile: string; model: string; fallback?: string; filter?: string; thinking?: string;
  primaryEffort?: string; processing?: string;
}): ReviewerEffort | undefined {
  const effort = validateReviewerEffort(value,config);
  if(effort===undefined)return undefined;
  if(!config.primaryEffort || config.primaryEffort===effort || config.processing!=='single-pass')
    throw new Error('--shadow-review-effort requires a distinct explicit --review-effort and single-pass processing');
  return effort;
}

export function validateReviewerEffort(value: string | undefined, config: {
  compare: string; profile: string; model: string; fallback?: string; filter?: string; thinking?: string;
}): ReviewerEffort | undefined {
  if (value === undefined) return undefined;
  if (value !== 'low' && value !== 'high' && value !== 'max')
    throw new Error('--review-effort must be low, high or max');
  validateReviewerThinking('enabled', config);
  if (config.thinking === 'disabled') throw new Error('--review-effort conflicts with disabled review thinking');
  return value;
}

/** Bind every review turn to one effort; the base client remains usable by the predictor. */
export function configureReviewerEffort(client: LlmClient, effort?: ReviewerEffort): LlmClient {
  if (effort === undefined) return client;
  configureReviewerThinking(client, 'enabled');
  const bind = (base: LlmClient): LlmClient => ({
    id: base.id,
    traceMetadata: Object.freeze({ ...base.traceMetadata, reviewer_reasoning_effort: effort }),
    reasoningConfiguration: () => base.reasoningConfiguration!(effort),
    startConversation: () => bind(base.startConversation?.() ?? base),
    complete: request => base.complete({ ...request, effort }),
  });
  return bind(client);
}

/** Shared by admission and the runner; an omitted flag preserves existing providers. */
export function validateReviewerThinking(value: string | undefined, config: {
  compare: string; profile: string; model: string; fallback?: string; filter?: string;
}): ReviewerThinking | undefined {
  if (value === undefined) return undefined;
  if (value !== 'enabled' && value !== 'disabled')
    throw new Error('--review-thinking must be enabled or disabled');
  if (!config.compare.split(',').some(arm => arm === 'web-filter' || arm === 'mixed' || arm === 'both') || config.profile !== 'quality-v1' || config.filter === '0')
    throw new Error('--review-thinking requires quality-v1 web-filter with review enabled');
  if (config.model !== 'deepseek:deepseek-flash' || config.fallback)
    throw new Error('--review-thinking requires deepseek:deepseek-flash without a fallback reviewer');
  return value;
}

/** Clone only the reviewer; never mutate the prediction client or its output budget. */
export function configureReviewerThinking(client: LlmClient, mode?: ReviewerThinking): LlmClient {
  if (mode === undefined) return client;
  if (!(client instanceof OpenAiCompatibleClient) || !isNativeDeepSeekFlash(
    String(client.traceMetadata?.provider), String(client.traceMetadata?.model), String(client.traceMetadata?.base_url)))
    throw new Error('Reviewer thinking requires a native DeepSeek Flash client');
  if (mode === 'disabled') return client.withThinkingDisabled();
  // Native Flash's existing provider default is thinking on. Preserve that exact
  // historical request and cache identity; reject an already-disabled instance.
  if (client.reasoningConfiguration()?.reasoning_mode === 'disabled')
    throw new Error('Reviewer already has thinking disabled');
  return client;
}
