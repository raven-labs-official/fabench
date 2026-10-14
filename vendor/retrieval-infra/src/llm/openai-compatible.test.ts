import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from 'node:http';
import type { Permit } from "./shared-rate-limit.js";

for (const disconnect of ['socket-reset','early-end']) test(`a real ${disconnect} after response headers retries the same request and discards partial output`, async () => {
  const events:any[]=[], releases:boolean[]=[], bodies:string[]=[];
  let requests=0;
  const server=createServer(async (req,res)=>{
    let body='';for await(const part of req)body+=part;bodies.push(body);
    requests++;res.writeHead(200,{'content-type':'text/event-stream'});
    if(requests===1){
      res.write('data: '+JSON.stringify({choices:[{delta:{content:'unfinished answer',reasoning_content:'Synthetic partial thought.',
        tool_calls:[{index:0,id:'discarded',function:{name:'never_execute',arguments:'{}'}}]},finish_reason:null}]})+'\n\n');
      setTimeout(()=>disconnect==='socket-reset'?res.destroy():res.end(),30);
    }else res.end('data: '+JSON.stringify({choices:[{delta:{content:'complete answer'},finish_reason:'stop'}],
      usage:{prompt_tokens:10,completion_tokens:3}})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=(server.address() as {port:number}).port;
    const client=new OpenAiCompatibleClient({providerId:'custom',model:'fixture',apiKey:'fixture',baseUrl:`http://127.0.0.1:${port}`,
      admission:{async acquire(){return {limited:()=>{},release:success=>releases.push(!!success)};}}});
    const result=await client.complete({prompt:'fixture',onTrace:event=>events.push(event)});
    assert.equal(requests,2);assert.deepEqual(releases,[false,true]);assert.equal(bodies[0],bodies[1]);
    assert.equal(result.text,'complete answer');assert.equal(result.reasoning,undefined);assert.equal(result.toolCalls,undefined);
    assert.ok(events.some(e=>e.type==='http_attempt_failed'&&e.data.phase==='response-body'&&e.data.attempt===1));
    assert.ok(events.some(e=>e.type==='provider_reasoning_frames'&&JSON.stringify(e.data).includes('Synthetic partial thought.')));
    assert.ok(events.some(e=>e.type==='provider_reasoning_capture'&&e.data.stream_complete===false));
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('stream failures share the three-attempt transport budget and release every permit', async () => {
  let requests=0;const releases:boolean[]=[];
  const server=createServer((_req,res)=>{
    requests++;res.writeHead(200,{'content-type':'text/event-stream'});res.write(': keepalive\n\n');
    setTimeout(()=>res.destroy(),20);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=(server.address() as {port:number}).port;
    const client=new OpenAiCompatibleClient({providerId:'custom',model:'fixture',apiKey:'fixture',baseUrl:`http://127.0.0.1:${port}`,
      admission:{async acquire(){return {limited:()=>{},release:success=>releases.push(!!success)};}}});
    await assert.rejects(client.complete({prompt:'fixture'}),/terminated|closed|socket/i);
    assert.equal(requests,3);assert.deepEqual(releases,[false,false,false]);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('cancelling a streamed response preserves received reasoning and releases the permit as failed',async()=>{
  const controller=new AbortController(),events:any[]=[],releases:boolean[]=[];let requests=0;
  const server=createServer((_req,res)=>{requests++;res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'Synthetic partial thought.'},finish_reason:null}]})+'\n\n');
    const timer=setTimeout(()=>controller.abort(new Error('cancel streaming test')),100);res.on('close',()=>clearTimeout(timer));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=(server.address() as {port:number}).port;
    const client=new OpenAiCompatibleClient({providerId:'custom',model:'fixture',apiKey:'fixture',baseUrl:`http://127.0.0.1:${port}`,admission:{async acquire(){return {limited:()=>{},release:success=>{releases.push(!!success);}};}}});
    await assert.rejects(client.complete({prompt:'fixture',signal:controller.signal,onTrace:event=>events.push(event)}),/abort|cancel/i);
    assert.equal(requests,1);assert.deepEqual(releases,[false]);
    assert.ok(events.some(e=>e.type==='provider_reasoning_frames'&&JSON.stringify(e.data).includes('Synthetic partial thought.')));
    assert.ok(events.some(e=>e.type==='provider_reasoning_capture'&&e.data.stream_complete===false));
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

import {
  classifyProviderHttpError,
  completionTokenParams,
  OpenAiCompatibleClient,
  providerRequestParams,
  REASONING_REPLAY_POLICY,
  reportedContextHeadroom,
  thinkingParams,
} from "./openai-compatible.js";

test('observed DeepSeek reasoning-replay rejection is an explicit non-retryable contract failure', () => {
  const body=JSON.stringify({error:{code:'invalid_request_error',message:'The `reasoning_content` in the thinking mode must be passed back to the API.'}});
  const error=classifyProviderHttpError('deepseek',400,body);
  assert.equal(error.category,'reasoning_replay_required');
  assert.equal(error.retryable,false);
  assert.equal(classifyProviderHttpError('deepseek',400,'{"error":{"message":"Invalid field"}}').category,'http_error');
  assert.equal(classifyProviderHttpError('deepseek',500,body).category,'server_error');
});

test('reported context overflow from N30 preserves input and caps only the remaining output room', () => {
  // Actual provider error in run 712fd458, question N30, 2026-09-15.
  const error = (context=1048576,total=1086473,input=702473,output=384000) => JSON.stringify({error:{message:
    `This model's maximum context length is ${context} tokens. However, you requested ${total} tokens (${input} in the messages, ${output} in the completion). Please reduce the length of the messages or completion.`}});
  assert.deepEqual(reportedContextHeadroom('deepseek',400,error(),384000), {
    max_tokens:346103,context_tokens:1048576,input_tokens:702473,rejected_max_tokens:384000,
  });
  assert.equal(reportedContextHeadroom('custom',400,error(),384000),undefined);
  assert.equal(reportedContextHeadroom('deepseek',429,error(),384000),undefined);
  assert.equal(reportedContextHeadroom('deepseek',400,error(),1000),undefined);
  assert.equal(reportedContextHeadroom('deepseek',400,error(1048576,1086474),384000),undefined);
  assert.equal(reportedContextHeadroom('deepseek',400,error(702473,1086473),384000),undefined);
  assert.equal(reportedContextHeadroom('deepseek',400,'not JSON',384000),undefined);
});

test("GLM balance exhaustion is non-retryable while an ordinary 429 remains retryable", () => {
  const balance = classifyProviderHttpError(
    "glm",
    429,
    JSON.stringify({ error: { code: 1113, message: "余额不足或无可用资源包,请充值。" } }),
  );
  assert.equal(balance.category, "insufficient_balance");
  assert.equal(balance.providerCode, "1113");
  assert.equal(balance.retryable, false);

  const limited = classifyProviderHttpError(
    "glm",
    429,
    JSON.stringify({ error: { code: 1302, message: "Too many requests" } }),
  );
  assert.equal(limited.category, "rate_limited");
  assert.equal(limited.retryable, true);
});

test("Bailian token quota throttling is retryable without changing other providers' billing errors", () => {
  const body = JSON.stringify({error:{code:"insufficient_quota",message:"You exceeded your current quota, please check your plan and billing details."}});
  const limited = classifyProviderHttpError("bailian",429,body);
  assert.equal(limited.category,"rate_limited");
  assert.equal(limited.retryable,true);
  assert.equal(limited.providerCode,"insufficient_quota");
  assert.equal(classifyProviderHttpError("custom",429,body).category,"insufficient_balance");
  assert.equal(classifyProviderHttpError("bailian",402,'{"error":{"code":"insufficient_balance","message":"Insufficient balance"}}').retryable,false);
});

test("transport reports a shared 429, honors Retry-After at admission, and releases each attempt",async()=>{
  const original=globalThis.fetch;let calls=0,acquired=0,released=0;const limited:Array<string|null|undefined>=[];
  globalThis.fetch=async()=>{
    calls++;
    if(calls===1)return new Response('{"error":{"message":"Too many requests"}}',{status:429,headers:{"retry-after":"120"}});
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{"content-type":"text/event-stream"}});
  };
  try {
    const client=new OpenAiCompatibleClient({providerId:"custom",apiKey:"test",baseUrl:"https://example.test/v1",model:"test",admission:{
      async acquire():Promise<Permit>{acquired++;return{limited:value=>{limited.push(value);},release:()=>{released++;}};},
    }});
    assert.equal((await client.complete({prompt:"test"})).text,"ok");
    assert.equal(calls,2);assert.equal(acquired,2);assert.equal(released,2);assert.deepEqual(limited,["120"]);
  } finally {globalThis.fetch=original;}
});
test("Bailian insufficient_quota enters shared cooldown and retries the same request",async()=>{
  const original=globalThis.fetch;let acquired=0,released=0;const requests:string[]=[];const limited:Array<string|null|undefined>=[];
  globalThis.fetch=async(_url,init)=>{
    requests.push(String(init?.body));
    if(requests.length===1)return new Response('{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}',{status:429,headers:{"retry-after":"60"}});
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{"content-type":"text/event-stream"}});
  };
  try {
    const client=new OpenAiCompatibleClient({providerId:"bailian",apiKey:"test",baseUrl:"https://example.test/v1",model:"qwen3.6-35b-a3b",admission:{
      async acquire():Promise<Permit>{acquired++;return{limited:value=>{limited.push(value);},release:()=>{released++;}};},
    }});
    assert.equal((await client.complete({prompt:"test"})).text,"ok");
    assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);
    assert.equal(acquired,2);assert.equal(released,2);assert.deepEqual(limited,["60"]);
  } finally {globalThis.fetch=original;}
});
test("balance exhaustion is neither shared throttling nor a repeated transport request",async()=>{
  const original=globalThis.fetch;let calls=0,limits=0,releases=0;
  globalThis.fetch=async()=>{calls++;return new Response('{"error":{"code":1113,"message":"余额不足"}}',{status:429});};
  try {
    const client=new OpenAiCompatibleClient({providerId:"glm",apiKey:"test",baseUrl:"https://example.test/v1",model:"glm-5.2",admission:{
      async acquire(){return{limited:()=>{limits++;},release:()=>{releases++;}};},
    }});
    await assert.rejects(client.complete({prompt:"test"}),/insufficient_balance/);
    assert.equal(calls,1);assert.equal(limits,0);assert.equal(releases,1);
  } finally {globalThis.fetch=original;}
});

test("known models receive their documented maximum while unknown models use provider defaults", () => {
  assert.deepEqual(completionTokenParams("deepseek", "deepseek-v4-flash"), {
    max_tokens: 384000,
  });
  assert.deepEqual(completionTokenParams("deepseek", "deepseek-v4-pro"), {
    max_tokens: 384000,
  });
  assert.deepEqual(completionTokenParams("glm", "glm-5.2"), {
    max_tokens: 131072,
  });
  assert.deepEqual(completionTokenParams("bailian", "glm-5.3"), {
    max_tokens: 131072,
  });
  assert.deepEqual(completionTokenParams("bailian", "qwen3.8-27b"), {
    max_tokens: 131072,
  });
  assert.deepEqual(completionTokenParams("bailian", "kimi-k3"), {
    max_tokens: 1048576,
  });
  assert.deepEqual(completionTokenParams("kimi", "k3"), {
    max_tokens: 1048576,
  });
  assert.deepEqual(completionTokenParams("custom", "unknown-model"), {});
});

test("Bailian GLM enables streamed tool calls only when tools are present", () => {
  assert.deepEqual(providerRequestParams("bailian", "glm-5.2", true), {
    tool_stream: true,
  });
  assert.deepEqual(providerRequestParams("bailian", "glm-5.2", false), {});
  assert.deepEqual(providerRequestParams("bailian", "qwen3.8-27b", true), {});
  assert.deepEqual(providerRequestParams("glm", "glm-5.2", true), {});
});

test("reasoning effort remains provider-native and nullable", () => {
  assert.deepEqual(thinkingParams("deepseek", "deepseek-v4-pro", undefined, 0.3), {
    temperature: 0.3,
  });
  assert.deepEqual(thinkingParams("deepseek", "deepseek-v4-pro", "max", 0.3), {
    reasoning_effort: "max",
    temperature: 0.3,
  });
  assert.deepEqual(thinkingParams("kimi", "k3", "low", 0.3), {
    reasoning_effort: "low",
  });
  assert.deepEqual(thinkingParams("custom", "claude-opus-5", "high", 0.3), {
    thinking: { type: "adaptive" },
  });
});

test("reasoning metadata distinguishes explicit, translated, and provider default", () => {
  const deepseek = new OpenAiCompatibleClient({
    providerId: "deepseek",
    apiKey: "test",
    baseUrl: "https://example.test/v1",
    model: "deepseek-v4-pro",
    priceInputPerM: 1,
    priceOutputPerM: 2,
  });
  assert.deepEqual(deepseek.reasoningConfiguration(), {
    reasoning_mode: null,
    thinking_effort: null,
    requested_thinking_effort: null,
    source: "provider-default",
    api_parameters: { temperature: 0.3 },
    history_replay: { policy: "same-task-tool-loop-v1", field: "reasoning_content" },
  });
  assert.equal(deepseek.traceMetadata.max_tokens, 384000);
  assert.equal(deepseek.traceMetadata.max_tokens_source, "provider-model-maximum");
  assert.equal(deepseek.reasoningConfiguration("max").thinking_effort, "max");

  const glm = new OpenAiCompatibleClient({
    providerId: "glm",
    apiKey: "test",
    baseUrl: "https://example.test/v1",
    model: "glm-5.2",
  });
  assert.equal(glm.traceMetadata.max_tokens, 131072);
  assert.equal(glm.traceMetadata.max_tokens_source, "provider-model-maximum");

  const claude = new OpenAiCompatibleClient({
    providerId: "custom",
    apiKey: "test",
    baseUrl: "https://example.test/v1",
    model: "claude-opus-5",
  });
  const translated = claude.reasoningConfiguration("high");
  assert.equal(translated.reasoning_mode, "adaptive");
  assert.equal(translated.thinking_effort, null);
  assert.equal(translated.requested_thinking_effort, "high");
  assert.equal(translated.source, "translated");

  const bailian = new OpenAiCompatibleClient({
    providerId: "bailian",
    apiKey: "test",
    baseUrl: "https://example.test/v1",
    model: "qwen3.8-27b",
    pricingKnown: false,
  });
  assert.equal(bailian.traceMetadata.max_tokens, 131072);
  assert.equal(bailian.traceMetadata.max_tokens_source, "provider-model-maximum");
  assert.equal(
    (bailian.traceMetadata.pricing as { known: boolean }).known,
    false,
  );
});

function streamClient() {
  return new OpenAiCompatibleClient({providerId:"custom",model:"fixture-model",apiKey:"test-secret-never-log",baseUrl:"https://example.test/v1"});
}
function sseResponse(frames: unknown[]) {
  return new Response(frames.map(x=>`data: ${JSON.stringify(x)}\n\n`).join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
}

test('explicit non-thinking Flash keeps tools and local capture, omits reasoning history, and isolates the original client',async()=>{
  const original=globalThis.fetch, requests:any[]=[], events:any[]=[], releases:boolean[]=[];
  const base=new OpenAiCompatibleClient({providerId:'deepseek',model:'deepseek-flash',apiKey:'test-secret',baseUrl:'https://api.deepseek.com/v1',
    admission:{async acquire(){return {limited:()=>{},release:ok=>releases.push(!!ok)};}}});
  const client=base.withThinkingDisabled(4096);
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return sseResponse([
    {choices:[{delta:{reasoning_content:'Unexpected provider thought retained locally.',content:'{"status":"supported"}'},finish_reason:'stop'}]},
    {choices:[],usage:{prompt_tokens:10,completion_tokens:8,completion_tokens_details:{reasoning_tokens:2}}},
  ]);};
  try {
    assert.equal(base.reasoningConfiguration().reasoning_mode,null);
    assert.equal(base.traceMetadata.max_tokens,384000);
    assert.equal(client.reasoningConfiguration().reasoning_mode,'disabled');
    assert.equal(client.reasoningConfiguration().source,'explicit');
    assert.equal(client.reasoningConfiguration().history_replay,null);
    assert.equal(client.traceMetadata.reasoning_history_field,null);
    assert.equal(client.traceMetadata.max_tokens_source,'explicit-diagnostic');
    const req={prompt:'',messages:[{role:'user' as const,content:'page'},{role:'assistant' as const,content:'prior',reasoning:'private history'}],
      tools:[{name:'search_evidence',description:'find date',parameters:{type:'object'}}],onTrace:(e:any)=>events.push(e)};
    const result=await client.complete(req);
    assert.deepEqual(requests[0].thinking,{type:'disabled'});
    assert.equal(requests[0].max_tokens,4096);assert.equal(requests[0].tools[0].function.name,'search_evidence');
    assert.ok(!JSON.stringify(requests[0]).includes('private history'));
    assert.equal(result.reasoning,'Unexpected provider thought retained locally.');
    assert.ok(events.some(e=>e.type==='http_request_prepared'&&e.data.generation_parameters.thinking.type==='disabled'&&e.data.max_tokens_source==='explicit-diagnostic'));
    await client.complete({...req,tools:undefined});
    assert.deepEqual(requests[1].thinking,{type:'disabled'});assert.equal(requests[1].tools,undefined);
    await assert.rejects(client.complete({...req,effort:'high'}),/conflicts/);
    await assert.rejects(client.complete({...req,model:'deepseek-v4-pro'}),/conflicts/);
    assert.equal(requests.length,2);assert.deepEqual(releases,[true,true]);
    assert.throws(()=>base.withThinkingDisabled(0),/output limit/);
    assert.throws(()=>base.withThinkingDisabled(384001),/output limit/);
    assert.throws(()=>streamClient().withThinkingDisabled(),/native DeepSeek Flash/);
  }finally{globalThis.fetch=original;}
});

test("streamed reasoning aliases and native structured artifacts are retained without changing the request",async()=>{
  const saved=globalThis.fetch;const events:any[]=[];let request:any;
  globalThis.fetch=async(_url,init)=>{
    request=JSON.parse(String(init?.body));
    return sseResponse([
      {choices:[{delta:{reasoning:"Exact reasoning ",reasoning_details:[{type:"reasoning.encrypted",data:"opaque-1"}]}}]},
      {choices:[{delta:{reasoning:"continues.\n",reasoning_details:[{type:"reasoning.text",text:"Native detail"}]}}]},
      {choices:[{delta:{content:"0.6"},finish_reason:"stop"}]},
    ]);
  };
  try {
    const result=await streamClient().complete({prompt:"fixture",onTrace:e=>events.push(e)});
    assert.equal(result.reasoning,"Exact reasoning continues.\n");assert.equal(result.text,"0.6");
    assert.equal(result.reasoningCapture?.status,"text_returned");assert.equal(result.reasoningCapture?.stream_complete,true);
    assert.deepEqual(result.reasoningCapture?.native_fields,["reasoning","reasoning_details"]);
    const native=events.filter(e=>e.type==="provider_reasoning_frames").flatMap(e=>e.data.frames);
    assert.equal(native.length,2);assert.equal(native[0].fields.reasoning_details[0].data,"opaque-1");
    assert.ok(!JSON.stringify(events).includes("test-secret-never-log"));
    assert.equal(request.reasoning_effort,undefined);assert.equal(request.enable_thinking,undefined);
  } finally {globalThis.fetch=saved;}
});

test("reasoning survives a length-only error before an assistant reply can be returned",async()=>{
  const saved=globalThis.fetch;const events:any[]=[];
  globalThis.fetch=async()=>sseResponse([{choices:[{delta:{reasoning_content:"Thinking preserved even without an answer."},finish_reason:"length"}]}]);
  try {
    await assert.rejects(()=>streamClient().complete({prompt:"fixture",onTrace:e=>events.push(e)}),/finish_reason=length/);
    const native=events.find(e=>e.type==="provider_reasoning_frames");
    assert.equal(native.data.frames[0].fields.reasoning_content,"Thinking preserved even without an answer.");
    assert.equal(events.find(e=>e.type==="provider_reasoning_capture").data.status,"text_returned");
  } finally {globalThis.fetch=saved;}
});

test("a broken stream retains received reasoning and marks it incomplete",async()=>{
  const saved=globalThis.fetch;const events:any[]=[];let pulls=0;
  globalThis.fetch=async()=>new Response(new ReadableStream({pull(controller){
    if(pulls++===0) controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"Received prefix"}}]}\n\n'));
    else controller.error(new Error("fixture connection interrupted"));
  }}));
  try {
    await assert.rejects(()=>streamClient().complete({prompt:"fixture",onTrace:e=>events.push(e)}),/fixture connection/);
    assert.equal(events.find(e=>e.type==="provider_reasoning_frames").data.frames[0].fields.reasoning_content,"Received prefix");
    assert.equal(events.find(e=>e.type==="provider_reasoning_capture").data.stream_complete,false);
  } finally {globalThis.fetch=saved;}
});

test("no reasoning text, empty text and opaque artifacts remain distinguishable",async()=>{
  const saved=globalThis.fetch;
  try {
    for(const [delta,status] of [[{content:"0.4"},"not_returned"],[{content:"0.4",reasoning_content:""},"empty"],[{content:[{type:"thinking",thinking:"Native block"},{type:"text",text:"0.4"}]},"artifact_only"]] as const) {
      const events:any[]=[];globalThis.fetch=async()=>sseResponse([{choices:[{delta,finish_reason:"stop"}]}]);
      const result=await streamClient().complete({prompt:"fixture",onTrace:e=>events.push(e)});
      assert.equal(result.reasoningCapture?.status,status);assert.equal(result.text,"0.4");
      if(status==="artifact_only") assert.equal(events.find(e=>e.type==="provider_reasoning_frames").data.frames[0].fields.content[0].thinking,"Native block");
    }
  } finally {globalThis.fetch=saved;}
});

test("a tool task returns its own reasoning only where the provider reads it, without retention switches", async () => {
  const saved = globalThis.fetch;
  const requests: any[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return sseResponse([{ choices: [{ delta: { reasoning_content: "Archive this thought.", content: "0.5" }, finish_reason: "stop" }] }]);
  };
  try {
    // A stray native field from an old caller is never forwarded; only `reasoning` is the source.
    const messages = [
      { role: "system" as const, content: "rules" },
      { role: "user" as const, content: "task", reasoning: "not an assistant turn" },
      { role: "assistant" as const, content: "", reasoning: "Earlier thought", reasoning_content: "Old native thought", toolCalls: [{ id: "call-1", name: "lookup", args: {} }] },
      { role: "tool" as const, toolCallId: "call-1", content: "result" },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "call-2", name: "lookup", args: {} }] },
      { role: "tool" as const, toolCallId: "call-2", content: "result" },
      { role: "assistant" as const, content: "", reasoning: "", toolCalls: [{ id: "call-3", name: "lookup", args: {} }] },
      { role: "tool" as const, toolCallId: "call-3", content: "result" },
    ];
    const cases = [["deepseek", "deepseek-flash", true], ["glm", "glm-5.3-flash", true], ["kimi", "k3", true],
      ["bailian", "qwen3.8-flash", true], ["custom", "claude-opus-5", false], ["openrouter", "anthropic/claude-5", false]] as const;
    for (const [provider, model, replays] of cases) {
      const client = new OpenAiCompatibleClient({ providerId: provider, model, apiKey: "test", baseUrl: "https://example.test/v1" });
      const events: any[] = [];
      const result = await client.complete({ prompt: "", messages, tools: [{ name: "lookup", description: "x", parameters: {} }], onTrace: e => events.push(e) });
      const req = requests.at(-1);
      for (const m of req.messages) assert.equal(m.reasoning, undefined, provider);
      assert.equal(req.messages[1].reasoning_content, undefined, provider);
      assert.equal(req.messages[2].reasoning_content, replays ? "Earlier thought" : undefined, provider);
      assert.equal("reasoning_content" in req.messages[4], false, provider);
      assert.equal(req.messages[6].reasoning_content, replays ? "" : undefined, provider);
      assert.equal(req.preserve_thinking, undefined);
      assert.equal(req.clear_thinking, undefined);
      assert.equal(req.thinking?.clear_thinking, undefined);
      assert.equal(req.messages[2].tool_calls[0].id, "call-1");
      assert.equal(req.messages[3].tool_call_id, "call-1");
      assert.equal(result.reasoning, "Archive this thought.");
      assert.equal(events.find(e => e.type === "provider_reasoning_frames").data.frames[0].fields.reasoning_content, "Archive this thought.");
      assert.deepEqual(client.reasoningConfiguration().history_replay,
        replays ? { policy: REASONING_REPLAY_POLICY.version, field: "reasoning_content" } : null, provider);
      assert.equal(client.traceMetadata.reasoning_history_field, replays ? "reasoning_content" : null, provider);
    }
  } finally { globalThis.fetch = saved; }
});

test("the SSE data line is found exactly as splitting the frame into lines would", async () => {
  const { firstDataLine } = await import("./openai-compatible.js");
  const frames = ["data: {\"a\":1}", "event: x\ndata: {\"b\":2}", ": ping", "", "event: x\nid: 3\ndata: [DONE]\r",
    "data:no-space\ndata: second", "id: 1\nmetadata: nope\ndata: yes", "\ndata: leading", "event: only\n", "xdata: no\ndata: ok"];
  for (const frame of frames)
    assert.equal(firstDataLine(frame), frame.split("\n").find((l) => l.startsWith("data:")), JSON.stringify(frame));
});

test('a stream that keeps sending outlives the idle deadline; the deadline restarts on each chunk', async () => {
  const server=createServer((_req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    let sent=0;
    const tick=setInterval(()=>{
      if(++sent<8){res.write('data: '+JSON.stringify({choices:[{delta:{content:`p${sent} `},finish_reason:null}]})+'\n\n');return;}
      clearInterval(tick);
      res.end('data: '+JSON.stringify({choices:[{delta:{content:'end'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    },40);
    res.on('close',()=>clearInterval(tick));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=(server.address() as {port:number}).port;
    const releases:boolean[]=[];
    const client=new OpenAiCompatibleClient({providerId:'custom',model:'fixture',apiKey:'fixture',baseUrl:`http://127.0.0.1:${port}`,timeoutMs:150,
      admission:{async acquire(){return {limited:()=>{},release:success=>releases.push(!!success)};}}});
    const result=await client.complete({prompt:'fixture'});
    assert.equal(result.text,'p1 p2 p3 p4 p5 p6 p7 end');assert.deepEqual(releases,[true]);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
