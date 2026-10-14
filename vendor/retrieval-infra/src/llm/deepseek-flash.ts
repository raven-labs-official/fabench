/** Native Flash mapping and published USD price schedule, verified 2026-09-10. */
export const DEEPSEEK_FLASH_DOCUMENTATION = "https://api-docs.deepseek.com/quick_start/pricing/";
const FLASH_NAMES = new Set(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);
export function isNativeDeepSeekFlash(provider: string, model: string, baseUrl: string): boolean {
  return provider === "deepseek" && FLASH_NAMES.has(model) && /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/.test(baseUrl);
}
export function deepseekFlashPriceCard(at: Date) {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  const peak = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  const multiplier = peak ? 2 : 1;
  return {
    currency: "USD", period: peak ? "peak" : "off-peak", request_started_at_utc: at.toISOString(),
    input_per_million_tokens: 0.15 * multiplier,
    cached_input_per_million_tokens: 0.003 * multiplier,
    output_per_million_tokens: 0.6 * multiplier,
    source: DEEPSEEK_FLASH_DOCUMENTATION,
    accounting: "Estimate at request start; completion_tokens includes reasoning tokens; vendor invoice is authoritative.",
  };
}
