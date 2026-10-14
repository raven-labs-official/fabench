import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "node:http";
import {OpenAiCompatibleClient} from "./openai-compatible.js";
import type {LlmMessage, LlmRequest} from "./client.js";

test("Claude caching preserves the tool conversation and stays enabled on the final turn", async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, {"content-type": "text/event-stream"});
    res.end('data: ' + JSON.stringify({choices: [{delta: {content: "done"}, finish_reason: "stop"}],
      usage: {prompt_tokens: 12000, completion_tokens: 10,
        prompt_tokens_details: {cached_tokens: 9000, cache_write_tokens: 2000}, cost: 0.024}}) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const client = (providerId: string, model: string) => new OpenAiCompatibleClient({
    providerId, model, baseUrl, apiKey: "synthetic", pricingKnown: false,
    admission: {async acquire() {return {limited() {}, release() {}};}},
  });
  try {
    const messages: LlmMessage[] = [
      {role: "system", content: "Original system\n原文"},
      {role: "user", content: "Original question"},
      {role: "assistant", content: "", toolCalls: Array.from({length: 25}, (_, i) => ({id: `c${i}`, name: "lookup", args: {i}}))},
      ...Array.from({length: 25}, (_, i): LlmMessage => ({role: "tool", toolCallId: `c${i}`, content: `evidence ${i}\n正文`})),
    ];
    const before = structuredClone(messages);
    const request: LlmRequest = {prompt: "", messages,
      tools: [{name: "lookup", description: "Unchanged tool", parameters: {type: "object"}}]};
    const events: any[] = [];
    const claude = client("openrouter", "anthropic/claude-opus-5");
    const result = await claude.complete({...request, onTrace: e => events.push(e)});
    await claude.complete({...request, tools: undefined});
    await client("custom", "anthropic/claude-opus-5").complete(request);
    await client("openrouter", "openai/test").complete(request);
    await claude.complete({...request, model: "openai/test"});
    assert.deepEqual(messages, before);
    assert.deepEqual(requests[0].cache_control, {type: "ephemeral"});
    assert.deepEqual(requests[1].cache_control, {type: "ephemeral"});
    for (const body of requests.slice(2)) assert.equal(body.cache_control, undefined);
    assert.deepEqual(requests[0].messages, requests[2].messages);
    assert.deepEqual(requests[0].tools, requests[2].tools);
    assert.deepEqual(requests[0].messages, messages.map(m => ({role: m.role, content: m.content,
      ...(m.toolCallId ? {tool_call_id: m.toolCallId} : {}),
      ...(m.toolCalls ? {tool_calls: m.toolCalls.map(t => ({id: t.id, type: "function",
        function: {name: t.name, arguments: JSON.stringify(t.args)}}))} : {})})));
    assert.equal(result.inputTokens, 12000);
    assert.equal(result.cachedInputTokens, 9000);
    assert.equal(result.cacheWriteInputTokens, 2000);
    assert.equal(result.costUsd, 0.024);
    assert.equal(events.find(e => e.type === "provider_usage").data.native_usage.cost, 0.024);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("missing cache telemetry stays unknown, explicit zero stays zero, and native hits remain priced", async () => {
  const usages = [
    {prompt_tokens: 1000, completion_tokens: 10},
    {prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: {cached_tokens: 0, cache_write_tokens: 0}},
    {prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 800},
  ];
  const server = createServer((_req, res) => {
    res.writeHead(200, {"content-type": "text/event-stream"});
    res.end('data: ' + JSON.stringify({choices: [{delta: {content: "done"}, finish_reason: "stop"}],
      usage: usages.shift()}) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new OpenAiCompatibleClient({providerId: "custom", model: "fixture", apiKey: "synthetic",
      baseUrl: `http://127.0.0.1:${(server.address() as {port: number}).port}`,
      priceInputPerM: 1, priceCacheHitPerM: 0.1, priceOutputPerM: 2,
      admission: {async acquire() {return {limited() {}, release() {}};}},
    });
    const events: any[] = [];
    const unknown = await client.complete({prompt: "question", onTrace: e => events.push(e)});
    assert.equal(unknown.cachedInputTokens, undefined);
    assert.equal(unknown.cacheWriteInputTokens, undefined);
    assert.equal(events.find(e => e.type === "provider_usage").data.cached_input_tokens, null);
    const miss = await client.complete({prompt: "question"});
    assert.equal(miss.cachedInputTokens, 0);
    assert.equal(miss.cacheWriteInputTokens, 0);
    const hit = await client.complete({prompt: "question"});
    assert.equal(hit.cachedInputTokens, 800);
    assert.ok(Math.abs(hit.costUsd - 0.0003) < 1e-12);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
