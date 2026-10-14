/**
 * Provider factory — turn a provider name into a configured LlmClient.
 *
 * This is the one place that knows about specific backends; everything else
 * (the predictor, the runner) works through the LlmClient interface. Add a
 * provider here, not in the predictor.
 */
import { isNativeDeepSeekFlash } from "./deepseek-flash.js";
import type { LlmClient } from "./client.js";
import { OpenAiCompatibleClient } from "./openai-compatible.js";
import { requireEnvKey, getEnvKey, getRenamedEnvKey } from "./load-env.js";

export type ProviderName = "deepseek" | "kimi" | "glm" | "bailian" | "openrouter";

/**
 * Every provider here speaks OpenAI-compatible HTTP. The `claude` CLI used to be one of them
 * and was removed: it spawns a process per call and runs a three-turn agent loop inside, which
 * measured 15.4s and $0.1237 against deepseek's 8.7s and $0.0039 on the same four documents,
 * with identical verdicts. `custom:<model>` reaches anything else with an OpenAI-compatible
 * endpoint.
 */
export const PROVIDERS: ProviderName[] = ["deepseek", "kimi", "glm", "bailian", "openrouter"];

/** Exact team-authorized plan models; snapshots and other models must not inherit this key. */
export const BAILIAN_CODING_PLAN_MODELS: readonly string[] = Object.freeze([
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen-image-3.0-pro",
  "qwen3.7-plus",
  "qwen3.7-max",
  "qwen3.6-flash",
]);
const BAILIAN_PLAN_BASE_URLS = new Set([
  "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
]);

/**
 * @param provider which backend
 * @param model    optional model override; each provider has its own default
 */
export function createLlmClient(provider: string, model?: string): LlmClient {
  // `custom:<model>` — endpoint and key come from CUSTOM_BASE_URL / CUSTOM_API_KEY, so a
  // run can point any OpenAI-compatible service at a job without editing this file. Added
  // for the leak reviewer, which wants a small fast model rather than the forecaster's.
  if (provider === "custom" || provider.startsWith("custom:")) {
    const id = provider.includes(":") ? provider.slice(provider.indexOf(":") + 1) : model;
    if (!id) throw new Error("custom provider needs a model: --leak-llm custom:<model-id>");
    return new OpenAiCompatibleClient({
      providerId: "custom",
      apiKey: requireEnvKey("CUSTOM_API_KEY"),
      baseUrl: requireEnvKey("CUSTOM_BASE_URL"),
      model: id,
      // Unknown pricing: report zero rather than invent a number that would land in a
      // cost total and be read as measured.
      priceInputPerM: Number(getEnvKey("CUSTOM_PRICE_IN") ?? 0),
      priceOutputPerM: Number(getEnvKey("CUSTOM_PRICE_OUT") ?? 0),
      pricingKnown:
        getEnvKey("CUSTOM_PRICE_IN") !== undefined &&
        getEnvKey("CUSTOM_PRICE_OUT") !== undefined,
    });
  }
  switch (provider) {

    case "deepseek": {
      const selectedModel = model || "deepseek-v4-pro";
      const baseUrl = getEnvKey("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com/v1";
      // deepseek-flash is V4.1 Flash; retired v4-flash names route to the same model.
      // Flash prices below are off-peak. The transport records the effective per-call card.
      const nativeFlash = isNativeDeepSeekFlash("deepseek", selectedModel, baseUrl);
      return new OpenAiCompatibleClient({
        providerId: "deepseek",
        apiKey: requireEnvKey("DEEPSEEK_API_KEY"),
        baseUrl,
        model: selectedModel,
        priceInputPerM: nativeFlash ? 0.15 : 0.435,
        priceCacheHitPerM: nativeFlash ? 0.003 : 0.003625,
        priceOutputPerM: nativeFlash ? 0.6 : 0.87,
      });
    }

    case "glm":
      // Zhipu GLM, OpenAI-compatible (verified 2026-06-23).
      // Default glm-4.5-flash = free tier (reasoning model, cost $0). The SOTA
      // models (glm-4.6 / glm-5 / glm-5.2) need account balance — pass --model
      // glm-4.6 after topping up. Endpoint: https://open.bigmodel.cn/api/paas/v4
      // Verified 2026-08-11: glm-4.7 answers ($0.60 in / $2.20 out per M). Most other ids in
      // the catalogue — glm-5.2, glm-5.1, glm-5, glm-4.6 — return HTTP 429 code 1113
      // "余额不足", i.e. an out-of-balance error dressed as a rate limit. glm-4.5-flash is
      // free but now marked deprecated by the vendor.
      // The team credential points at the GLM Coding Plan endpoint (/api/coding/paas/v4), a flat
      // subscription: token usage there has no attributable per-token price, so it is recorded
      // as unpriced rather than at the pay-as-you-go list price. Verified 2026-09-16:
      // glm-5.3-flash, glm-4.7-flash and glm-4.5-flash all answer on that endpoint.
      const glmBaseUrl = getEnvKey("GLM_BASE_URL") ?? "https://open.bigmodel.cn/api/paas/v4";
      const glmCodingPlan = /\/api\/coding\//.test(glmBaseUrl);
      return new OpenAiCompatibleClient({
        providerId: "glm",
        // A former name listed in the installation settings is read when GLM_API_KEY is unset.
        apiKey: getRenamedEnvKey("GLM_API_KEY") ?? requireEnvKey("GLM_API_KEY"),
        baseUrl: glmBaseUrl,
        model: model || "glm-4.7",
        priceInputPerM: glmCodingPlan ? 0 : 0.6,
        priceOutputPerM: glmCodingPlan ? 0 : 2.2,
        ...(glmCodingPlan ? { pricingKnown: false } : {}),
      });

    case "bailian": {
      const selectedModel = model || "qwen3.8-27b";
      if (BAILIAN_CODING_PLAN_MODELS.includes(selectedModel)) {
        // The team's Coding Plan-named credential uses the newer Token Plan endpoint.
        // Never fall back to pay-as-you-go when this credential is absent or rejected.
        const baseUrl = (getEnvKey("BAILIAN_CODING_PLAN_BASE_URL") ??
          "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
        if (!BAILIAN_PLAN_BASE_URLS.has(baseUrl)) {
          throw new Error("BAILIAN_CODING_PLAN_BASE_URL must be an official Token Plan endpoint");
        }
        return new OpenAiCompatibleClient({
          providerId: "bailian",
          apiKey: requireEnvKey("BAILIAN_CODING_PLAN_API_KEY"),
          baseUrl,
          model: selectedModel,
          allowedModels: [selectedModel],
          credentialResource: "bailian-coding-plan-team",
          pricingCurrency: "CNY",
          pricingKnown: false,
          usdCostKnown: false,
        });
      }
      // Other models retain the existing pay-as-you-go key and endpoint. The qwen3.8-27b
      // card is the Beijing public list price verified 2026-08-31: CNY 3/M input,
      // CNY 0.6/M implicit-cache input, and CNY 12/M output (including reasoning tokens).
      // Preserve CNY in the immutable trace and do not invent an exchange rate for costUsd.
      const baseUrl =
        getEnvKey("BAILIAN_BASE_URL") ??
        "https://dashscope.aliyuncs.com/compatible-mode/v1";
      const hasBeijingQwen38Price =
        selectedModel === "qwen3.8-27b" &&
        /^https:\/\/dashscope\.aliyuncs\.com(?:\/|$)/.test(baseUrl);
      return new OpenAiCompatibleClient({
        providerId: "bailian",
        apiKey: requireEnvKey("BAILIAN_API_KEY"),
        baseUrl,
        model: selectedModel,
        // A per-call override must not bypass the factory's credential selection.
        allowedModels: [selectedModel],
        priceInputPerM: hasBeijingQwen38Price ? 3 : 0,
        priceCacheHitPerM: hasBeijingQwen38Price ? 0.6 : 0,
        priceOutputPerM: hasBeijingQwen38Price ? 12 : 0,
        pricingCurrency: "CNY",
        pricingKnown: hasBeijingQwen38Price,
        usdCostKnown: false,
      });
    }

    case "kimi":
      // Verified 2026-08-11. The key we hold is a Kimi Code SUBSCRIPTION key, and it only
      // works against https://api.kimi.com/coding/v1 — the open developer platform
      // (api.moonshot.ai / api.moonshot.cn) returns "Invalid Authentication" for it. The
      // repo's old note blamed the key; the endpoint was the problem.
      //
      // GET /models on this endpoint lists exactly: kimi-for-coding,
      // kimi-for-coding-highspeed, k3, k3-256k. `k3` is the 1M-context flagship.
      //
      // Cost cannot be accounted for on this path: a subscription key has no per-token
      // price, so priceInput/Output stay 0 and any dollar figure we print for Kimi is
      // meaningless rather than free. Said explicitly because an unmeasurable spend is
      // exactly how the previous provider was run to zero without anyone noticing.
      return new OpenAiCompatibleClient({
        providerId: "kimi",
        apiKey: requireEnvKey("KIMI_API_KEY"),
        baseUrl: getEnvKey("KIMI_BASE_URL") ?? "https://api.kimi.com/coding/v1",
        model: model || "k3",
        pricingKnown: false,
      });

    case "openrouter":
      // OpenRouter, OpenAI-compatible. Key = FABENCH_OPENROUTER_API_KEY.
      // Model IDs are "vendor/model" — default is a lightweight, cheap model;
      // override with --model (e.g. google/gemini-2.0-flash-001, anthropic/claude-3.5-haiku).
      return new OpenAiCompatibleClient({
        providerId: "openrouter",
        apiKey: requireEnvKey("FABENCH_OPENROUTER_API_KEY"),
        baseUrl: getEnvKey("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1",
        model: model || "openai/gpt-4o-mini",
        pricingKnown: false,
      });

    default:
      throw new Error(`Unknown provider "${provider}". Known: ${PROVIDERS.join(", ")}`);
  }
}
