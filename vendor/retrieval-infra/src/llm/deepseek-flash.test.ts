import assert from "node:assert/strict";
import test from "node:test";
import { deepseekFlashPriceCard, isNativeDeepSeekFlash } from "./deepseek-flash.js";
import { OpenAiCompatibleClient, completionTokenParams } from "./openai-compatible.js";

test("Flash version mapping is restricted to documented native names and endpoint", () => {
  for (const model of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"])
    assert.equal(isNativeDeepSeekFlash("deepseek", model, "https://api.deepseek.com/v1"), true);
  assert.equal(isNativeDeepSeekFlash("custom", "deepseek-flash", "https://api.deepseek.com/v1"), false);
  assert.equal(isNativeDeepSeekFlash("deepseek", "deepseek-flash", "https://gateway.test/v1"), false);
  assert.equal(isNativeDeepSeekFlash("deepseek", "deepseek-v4-pro", "https://api.deepseek.com/v1"), false);
  assert.deepEqual(completionTokenParams("deepseek", "deepseek-flash"), {max_tokens: 384000});
});

test("Flash pricing applies only weekday peak windows and their exact boundaries", () => {
  for (const [time, peak] of [
    ["2026-09-10T00:59:59Z", false], ["2026-09-10T01:00:00Z", true],
    ["2026-09-10T04:00:00Z", false], ["2026-09-10T06:00:00Z", true],
    ["2026-09-10T10:00:00Z", false], ["2026-09-12T02:00:00Z", false],
    ["2026-09-13T07:00:00Z", false],
  ] as const) {
    const card = deepseekFlashPriceCard(new Date(time));
    assert.equal(card.period, peak ? "peak" : "off-peak");
    assert.equal(card.output_per_million_tokens, peak ? 1.2 : 0.6);
  }
});

test("native Flash records version and per-call prices without double billing reasoning", async (t) => {
  let request: any; const events: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    request = JSON.parse(String(init?.body));
    return new Response('data: {"model":"deepseek-flash","choices":[{"delta":{"content":"0.5","reasoning_content":"Local thought"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"prompt_cache_hit_tokens":800,"completion_tokens":100,"completion_tokens_details":{"reasoning_tokens":80}}}\n\ndata: [DONE]\n\n');
  });
  const client = new OpenAiCompatibleClient({providerId:"deepseek",model:"deepseek-flash",baseUrl:"https://api.deepseek.com/v1",apiKey:"test",priceInputPerM:0.15,priceCacheHitPerM:0.003,priceOutputPerM:0.6});
  const result = await client.complete({prompt:"Fixture",onTrace:e=>events.push(e)});
  const card = events.find(e=>e.type==="http_request_prepared").data.effective_price_card;
  assert.equal(result.costUsd, (200*card.input_per_million_tokens + 800*card.cached_input_per_million_tokens + 100*card.output_per_million_tokens)/1e6);
  assert.equal(result.reasoningTokens, 80);
  assert.equal(result.reasoning, "Local thought");
  assert.equal(client.traceMetadata.documented_model_version, "DeepSeek-V4.1-Flash");
  assert.equal(request.max_tokens, 384000);
  assert.equal(request.preserve_thinking, undefined);
  assert.equal(request.reasoning_content, undefined);
});
