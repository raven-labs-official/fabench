/** Native Anthropic input_tokens excludes cache reads and writes; FABench totals include both. */
export function claudeTokenUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
} | undefined) {
  return {
    inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) +
      (usage?.cache_creation_input_tokens ?? 0),
    outputTokens: usage?.output_tokens ?? 0,
    cachedInputTokens: usage?.cache_read_input_tokens,
    cacheWriteInputTokens: usage?.cache_creation_input_tokens,
  };
}
