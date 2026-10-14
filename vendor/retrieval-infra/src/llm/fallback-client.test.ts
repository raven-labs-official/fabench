import assert from "node:assert/strict";
import test from "node:test";
import type { LlmClient, LlmCompletion, LlmRequest } from "./client.js";
import { FallbackLlmClient } from "./fallback-client.js";
import { ProviderApiError, ProviderTransportError } from "./openai-compatible.js";
import { OpenAiCompatibleClient } from "./openai-compatible.js";
import { createServer } from "node:http";
import { apiResource, SharedRateLimiter } from "./shared-rate-limit.js";

const completion = (text: string): LlmCompletion => ({ text, costUsd: 0, inputTokens: 1, outputTokens: 1, provider: { model: text } });

function fake(id: string, behaviour: (req: LlmRequest) => Promise<LlmCompletion>, known = true): LlmClient & { calls: number } {
  return { id, calls: 0, traceMetadata: { pricing: { known } }, async complete(req) { this.calls++; return behaviour(req); } };
}

const admitted = (id: string) => fake(id, async req => { req.onTrace?.({ type: "shared_rate_admitted", data: { resource: id } }); return completion(id); });

for (const boundPrimary of [false, true]) test(`real early-ending streams ${boundPrimary ? 'retain an existing primary conversation' : 'fall back only after all three first-turn attempts'}`, async () => {
  const calls: {path: string; body: any}[] = [], events: any[] = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const path = req.url!, body = JSON.parse(text); calls.push({path, body});
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (boundPrimary && calls.length === 1) {
      res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'source',function:{name:'lookup',arguments:'{}'}}]},finish_reason:'tool_calls'}]})+'\n\n');
    } else if (path.startsWith('/primary')) {
      res.end('data: '+JSON.stringify({choices:[{delta:{content:'incomplete',reasoning_content:'Synthetic interrupted reasoning.'},finish_reason:null}]})+'\n\n');
    } else {
      res.end('data: '+JSON.stringify({choices:[{delta:{content:'complete'},finish_reason:'stop'}]})+'\n\n');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const admission = new SharedRateLimiter(':memory:');
  const baseUrl = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    const primary = new OpenAiCompatibleClient({providerId:'custom',baseUrl:baseUrl+'/primary',model:'primary',apiKey:'primary',admission});
    const fallback = new OpenAiCompatibleClient({providerId:'custom',baseUrl:baseUrl+'/fallback',model:'fallback',apiKey:'fallback',admission});
    const router = new FallbackLlmClient(primary, fallback, {admissionWaitMs:1000});
    const conversation = router.startConversation();
    const original = [{role:'user' as const,content:'verify page'}];
    if (boundPrimary) {
      const first = await conversation.complete({messages:original});
      const history = [...original,{role:'assistant' as const,content:first.text,toolCalls:first.toolCalls},
        {role:'tool' as const,toolCallId:'source',content:'evidence'}];
      await assert.rejects(conversation.complete({messages:history,onTrace:e=>events.push(e)}), ProviderTransportError);
      assert.equal(calls.length,4);
      assert.ok(calls.every(c=>c.path.startsWith('/primary')));
    } else {
      const result = await conversation.complete({messages:original,onTrace:e=>events.push(e)});
      assert.equal(result.text,'complete');
      assert.equal(result.reasoning,undefined);
      assert.deepEqual(calls.map(c=>c.path),['/primary/chat/completions','/primary/chat/completions','/primary/chat/completions','/fallback/chat/completions']);
      assert.ok(calls.every(c=>JSON.stringify(c.body.messages)===JSON.stringify(original)));
      assert.equal(events.find(e=>e.type==='fallback_client_used')?.data.reason,'primary_transport_retries_exhausted');
      assert.equal(events.filter(e=>e.type==='http_attempt_failed').length,3);
      assert.ok(events.some(e=>e.type==='provider_reasoning_capture'&&e.data.stream_complete===false));
      await conversation.complete({messages:original});
      assert.equal(calls.at(-1)?.path,'/fallback/chat/completions','new turns keep the selected fallback');
    }
    assert.equal(admission.snapshot().requests.length,0);
  } finally {
    admission.close(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test("an admitted primary answers and the fallback is never called", async () => {
  const primary = admitted("glm:flash"), fallback = admitted("deepseek:flash");
  const client = new FallbackLlmClient(primary, fallback, { admissionWaitMs: 100 });
  const events: string[] = [];
  const result = await client.complete({ prompt: "x", onTrace: e => events.push(e.type) });
  assert.equal(result.text, "glm:flash");
  assert.deepEqual([primary.calls, fallback.calls], [1, 1 - 1]);
  assert.deepEqual(client.counts, { primary: 1, fallback_after_wait: 0, fallback_after_error: 0 });
  assert.ok(events.includes("shared_rate_admitted") && !events.includes("fallback_client_used"));
  assert.equal(client.id, "glm:flash→deepseek:flash");
  assert.equal((client.traceMetadata.pricing as { known: boolean }).known, true);
});

test("a primary still waiting for admission after the wait budget spills to the fallback and is cancelled", async () => {
  let primaryAborted = false;
  const primary = fake("glm:flash", req => new Promise((_, reject) => {
    req.onTrace?.({ type: "http_request_prepared", data: { model: "glm:flash" } });
    req.onTrace?.({ type: "shared_rate_wait", data: { waited_ms: 0 } });
    req.signal?.addEventListener("abort", () => { primaryAborted = true; reject(req.signal?.reason ?? new Error("aborted")); }, { once: true });
  }));
  const fallback = admitted("deepseek:flash");
  const client = new FallbackLlmClient(primary, fallback, { admissionWaitMs: 120 });
  const events: { type: string; data?: unknown }[] = [];
  const started = Date.now();
  const result = await client.complete({ prompt: "x", onTrace: e => events.push(e) });
  assert.equal(result.text, "deepseek:flash");
  assert.ok(primaryAborted);
  assert.ok(Date.now() - started >= 100);
  const used = events.find(e => e.type === "fallback_client_used");
  assert.equal((used?.data as { reason: string }).reason, "primary_admission_wait_exceeded");
  assert.deepEqual(client.counts, { primary: 0, fallback_after_wait: 1, fallback_after_error: 0 });
});

test("real HTTP transport and SQLite admission spill over before sending a queued request", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const admission = new SharedRateLimiter(":memory:");
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const primaryResource = apiResource("custom", baseUrl, "primary");
  admission.configureResources([{ resource: primaryResource, concurrency: 1, min_gap_ms: 0, basis: "queue regression" }], "queue regression");
  const held = await admission.acquire(primaryResource);
  try {
    const primary = new OpenAiCompatibleClient({ providerId: "custom", baseUrl: baseUrl + "/primary", model: "primary", apiKey: "primary", admission });
    const fallback = new OpenAiCompatibleClient({ providerId: "custom", baseUrl: baseUrl + "/fallback", model: "fallback", apiKey: "fallback", admission });
    const client = new FallbackLlmClient(primary, fallback, { admissionWaitMs: 120 });
    const result = await client.complete({ prompt: "transport regression", signal: AbortSignal.timeout(3000) });
    assert.equal(result.text, "ok");
    assert.deepEqual(requests, ["/fallback/chat/completions"]);
    assert.equal(client.counts.fallback_after_wait, 1);
    assert.equal(admission.snapshot().requests.length, 1, "only the deliberately held permit remains");
  } finally {
    held.release(); admission.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a real primary 429 preserves shared cooldown and falls back without retrying it", async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url?.startsWith("/primary")) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
      res.end(JSON.stringify({ error: { code: 1302, message: "Rate limit" } }));
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const admission = new SharedRateLimiter(":memory:");
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const primary = new OpenAiCompatibleClient({ providerId: "glm", baseUrl: baseUrl + "/primary", model: "primary", apiKey: "primary", admission });
    const fallback = new OpenAiCompatibleClient({ providerId: "custom", baseUrl: baseUrl + "/fallback", model: "fallback", apiKey: "fallback", admission });
    const client = new FallbackLlmClient(primary, fallback, { admissionWaitMs: 120 });
    const result = await client.complete({ prompt: "transport regression", signal: AbortSignal.timeout(3000) });
    assert.equal(result.text, "ok");
    assert.deepEqual(requests, ["/primary/chat/completions", "/fallback/chat/completions"]);
    assert.equal(client.counts.fallback_after_error, 1);
    assert.equal(admission.snapshot().requests.length, 0);
    const primaryState = admission.snapshot().resources.find((r: any) => r.resource === apiResource("glm", baseUrl, "primary")) as any;
    assert.ok(primaryState.cooldown_until > Date.now() + 110_000, "primary cooldown remains in effect for other callers");
  } finally {
    admission.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a primary that was admitted is not abandoned when the wait budget passes", async () => {
  const primary = fake("glm:flash", async req => {
    req.onTrace?.({ type: "http_attempt_started", data: { attempt: 1 } });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(req.signal?.aborted, false);
    return completion("glm:flash");
  });
  const fallback = admitted("deepseek:flash");
  const client = new FallbackLlmClient(primary, fallback, { admissionWaitMs: 100 });
  const result = await client.complete({ prompt: "x" });
  assert.equal(result.text, "glm:flash");
  assert.equal(fallback.calls, 0);
});

test("rate limits, server errors and exhausted balance fall back; other provider errors surface", async () => {
  for (const [category, expectFallback] of [["rate_limited", true], ["server_error", true], ["insufficient_balance", true], ["authentication", false], ["reasoning_replay_required", false]] as const) {
    const primary = fake("glm:flash", async () => { throw new ProviderApiError("glm", 429, category, category === "rate_limited" || category === "server_error", "1302", "body"); });
    const fallback = admitted("deepseek:flash");
    const client = new FallbackLlmClient(primary, fallback, { admissionWaitMs: 100 });
    if (expectFallback) {
      const result = await client.complete({ prompt: "x" });
      assert.equal(result.text, "deepseek:flash", category);
      assert.equal(client.counts.fallback_after_error, 1, category);
    } else {
      await assert.rejects(client.complete({ prompt: "x" }), new RegExp(category));
      assert.equal(fallback.calls, 0, category);
    }
  }
});

test("a malformed-output failure and a caller cancellation never fall back", async () => {
  const primary = fake("glm:flash", async () => { throw new Error("Expected status, temporal reason"); });
  const fallback = admitted("deepseek:flash");
  const client = new FallbackLlmClient(primary, fallback, { admissionWaitMs: 100 });
  await assert.rejects(client.complete({ prompt: "x" }), /Expected status/);
  assert.equal(fallback.calls, 0);

  const controller = new AbortController();
  const waiting = fake("glm:flash", req => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("cancelled by caller")), { once: true })));
  const client2 = new FallbackLlmClient(waiting, fallback, { admissionWaitMs: 5_000 });
  const pending = client2.complete({ prompt: "x", signal: controller.signal });
  controller.abort(new Error("cancelled by caller"));
  await assert.rejects(pending, /cancelled by caller/);
  assert.equal(fallback.calls, 0);
});

test("pricing is only known when both clients price their usage and identical clients are rejected", () => {
  const primary = admitted("glm:flash"), unpriced = fake("deepseek:flash", async () => completion("d"), false);
  assert.equal((new FallbackLlmClient(primary, unpriced).traceMetadata.pricing as { known: boolean }).known, false);
  assert.throws(() => new FallbackLlmClient(primary, admitted("glm:flash")), /must differ/);
  const configuration = new FallbackLlmClient(primary, unpriced).reasoningConfiguration("high");
  assert.equal(configuration.requested_thinking_effort, "high");
  assert.ok("fallback_reasoning" in configuration.api_parameters);
});

for (const initial of ['primary','fallback'] as const) {
  test(`real tool conversation stays with its first ${initial} after admission pressure changes`, async () => {
    const calls: { path: string; body: any }[] = [];
    const server=createServer(async(req,res)=>{
      let text=''; for await(const chunk of req)text+=chunk;
      const path=req.url!,body=JSON.parse(text);calls.push({path,body});
      const model=path.startsWith('/primary')?'primary':'fallback';
      const followup=body.messages.some((m:any)=>m.role==='tool');
      res.writeHead(200,{'content-type':'text/event-stream'});
      const delta=followup?{content:'done'}:{tool_calls:[{index:0,id:`${model}-tool`,type:'function',function:{name:'lookup',arguments:'{}'}}]};
      res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:followup?'stop':'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const admission=new SharedRateLimiter(':memory:');
    const resource=apiResource('custom',baseUrl,'primary');
    admission.configureResources([{resource,concurrency:1,min_gap_ms:0,basis:'conversation regression'}],'conversation regression');
    let held: Awaited<ReturnType<SharedRateLimiter['acquire']>> | undefined;
    try {
      const primary=new OpenAiCompatibleClient({providerId:'custom',baseUrl:baseUrl+'/primary',model:'primary',apiKey:'primary',admission});
      const fallback=new OpenAiCompatibleClient({providerId:'custom',baseUrl:baseUrl+'/fallback',model:'fallback',apiKey:'fallback',admission});
      const router=new FallbackLlmClient(primary,fallback,{admissionWaitMs:100});
      const conversation=router.startConversation();
      if(initial==='fallback')held=await admission.acquire(resource);
      const first=await conversation.complete({messages:[{role:'user',content:'check source'}],signal:AbortSignal.timeout(3000)});
      assert.equal(first.toolCalls?.[0]?.id,`${initial}-tool`);
      if(initial==='fallback'){held!.release();held=undefined;}
      else {
        held=await admission.acquire(resource);
        setTimeout(()=>{held?.release();held=undefined;},250);
      }
      const result=await conversation.complete({messages:[
        {role:'user',content:'check source'},
        {role:'assistant',content:first.text,toolCalls:first.toolCalls},
        {role:'tool',toolCallId:first.toolCalls![0]!.id,content:'source evidence'},
      ],signal:AbortSignal.timeout(3000)});
      assert.equal(result.text,'done');
      assert.deepEqual(calls.map(c=>c.path),[`/${initial}/chat/completions`,`/${initial}/chat/completions`]);
      assert.ok(calls.every(c=>c.body.messages.every((m:any)=>!('reasoning_content' in m))));
      const next=router.startConversation();
      await next.complete({prompt:'new page',signal:AbortSignal.timeout(3000)});
      assert.equal(calls.at(-1)!.path,'/primary/chat/completions','each new page prefers the primary again');
    }finally{
      held?.release();admission.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  });
}
