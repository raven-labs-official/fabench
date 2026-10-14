import {ProviderApiError} from '../llm/openai-compatible.js';

/** DeepSeek may append a request ID to its page-specific content rejection. */
export function isDeepSeekContentRejection(error: unknown): error is ProviderApiError {
  return error instanceof ProviderApiError && error.providerId === 'deepseek' &&
    error.status === 400 && error.providerCode === 'invalid_request_error' &&
    /^Content Exists Risk\.?(?:\s+\(request_id:\s*[a-f0-9-]+\))?$/i.test(error.bodyExcerpt.trim());
}
