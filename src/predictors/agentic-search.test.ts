import assert from "node:assert/strict";
import test from "node:test";
import type { LlmClient, LlmRequest } from "../llm/client.js";
import type { SearchBackend } from "../retrieval/search-backend.js";
import { RetrievalInfrastructureError } from "../retrieval/infrastructure-error.js";
import type { Question } from "../types.js";
import type { TraceEventInput } from "../tracing/trace-archive.js";
import { BudgetTier, NullRetrievalEnv } from "./types.js";
import { AgenticSearchPredictor } from "./agentic-search.js";
import { OpenAiCompatibleClient } from "../llm/openai-compatible.js";
import {CorpusStore} from '../corpus/store.js';
import {QualityFrozenBackend} from '../../vendor/retrieval-infra/src/retrieval/quality-backend.js';
import {EvidenceStore} from '../../vendor/retrieval-infra/src/retrieval/evidence-store.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('frozen tools reject ambiguous arguments before SQL and retain separate search and browse paths',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'frozen-tool-arguments-')),store=new CorpusStore(':memory:','concept');
  const backend=new QualityFrozenBackend(store,new EvidenceStore(directory));
  const client=new OpenAiCompatibleClient({providerId:'custom',model:'unused',apiKey:'unused',baseUrl:'http://127.0.0.1:1'});
  const predictor=new AgenticSearchPredictor(client,backend);
  try{
    store.ingest([{url:'https://example.test/report',title:'Orion report',body:'Orion report retains its complete history.',crawlDate:'2026-02-01T00:00:00Z'}]);
    const call=(args:Record<string,unknown>)=>(predictor as any).runTool('web_search',args,'2026-03-01T00:00:00Z');
    assert.match((await call({query:'nuclear talks',entity:'Iran'})).content,/Choose exactly one/);
    assert.match((await call({query:'Orion',until:'2026-03-01'})).content,/cutoff is already enforced/);
    assert.equal(backend.stats().browses,0);assert.equal(backend.stats().searches,0);
    const searched=await call({query:'Orion report'}),browsed=await call({entity:'Orion',since:'2026-01-01'});
    assert.equal(JSON.parse(searched.content).results[0].snippet,'Orion report retains its complete history.');
    assert.equal(JSON.parse(browsed.content).results[0].snippet,'Orion report retains its complete history.');
    assert.match(predictor.id,/exclusive-search-arguments-v2/);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

const question: Question = {
  question_id: "trace-test",
  question_text: "Will the test event happen?",
  resolution_criteria: "Yes if the event happens by the deadline.",
  resolution_date: "2026-04-01T00:00:00Z",
  as_of_date: "2026-03-01T00:00:00Z",
  ground_truth: 1,
  market_price_at_freeze: null,
  category: "test",
  difficulty_level: "easy",
  source: "unit",
  language: "en",
};

test("three-turn HTTP requests carry the ordered conversation and tool IDs, return reasoning within one question only, and archive it", async () => {
  const original=globalThis.fetch;
  try {
    for (const [providerId, replays] of [["deepseek", true], ["custom", false]] as const) {
      const requests:any[]=[], events:TraceEventInput[]=[];
      let sequence=0;
      globalThis.fetch=async(_url,init)=>{
        const request=JSON.parse(String(init?.body));requests.push(request);
        const turn=sequence++%3;
        const tools=turn===0?[{index:0,id:'s1',type:'function',function:{name:'web_search',arguments:'{"query":"synthetic release"}'}}]:
          turn===1?[{index:0,id:'f1',type:'function',function:{name:'web_fetch',arguments:'{"url":"https://example.test/context"}'}}]:undefined;
        const delta={content:turn===2?'{"probability_yes":0.6,"numeric_forecast":null,"rationale":"Synthetic evidence."}':'Inspect evidence.',
          reasoning_content:`TURN_${sequence}_THOUGHT`,...(tools?{tool_calls:tools}:{})};
        return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:tools?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:10}})+'\n\ndata: [DONE]\n\n');
      };
      const backend:SearchBackend={name:'synthetic',async search(){return [{url:'https://example.test/context',title:'Synthetic source',snippet:'FIRST_RESULT'}];},
        async fetch(){return {url:'https://example.test/context',title:'Synthetic source',body:'FULL_READ_BODY',source:'frozen'};},stats(){return {};}};
      const client=new OpenAiCompatibleClient({providerId,apiKey:'synthetic',baseUrl:'https://example.test/v1',model:'synthetic',
        admission:{async acquire(){return {limited(){},release(){}};}}});
      const predictor=new AgenticSearchPredictor(client,backend,{maxToolCalls:3,trace:{record:e=>events.push(e)}});
      const q:Question={...question,response_format:'raven.forecast.v2.1',forecast_prompt:'APPROVED_QUESTION_CONTEXT',prediction_cutoff_utc:'2026-04-01T00:00:00Z'};
      await predictor.predict(q,NullRetrievalEnv,BudgetTier.Unlimited);
      assert.deepEqual(requests.map(r=>r.messages.map((m:any)=>m.role)),[
        ['system','user'],['system','user','assistant','tool'],['system','user','assistant','tool','assistant','tool']]);
      assert.equal(requests[2].messages[1].content,'APPROVED_QUESTION_CONTEXT');
      assert.match(requests[2].messages[3].content,/FIRST_RESULT/);assert.match(requests[2].messages[5].content,/FULL_READ_BODY/);
      for(const r of requests){
        for(let i=0;i<r.messages.length;i++)if(r.messages[i].role==='tool')assert.equal(r.messages[i].tool_call_id,r.messages[i-1].tool_calls[0].id);
        for(const m of r.messages)assert.equal(m.reasoning,undefined);
      }
      assert.deepEqual(requests[2].messages.filter((m:any)=>m.role==='assistant').map((m:any)=>m.reasoning_content),
        replays?['TURN_1_THOUGHT','TURN_2_THOUGHT']:[undefined,undefined], providerId);
      assert.doesNotMatch(JSON.stringify(requests),/TURN_3_THOUGHT/);
      assert.ok(events.some(e=>e.type==='assistant_message' && (e.data as any).reasoning==='TURN_1_THOUGHT'));
      assert.ok(events.some(e=>e.type==='assistant_message' && (e.data as any).reasoning==='TURN_3_THOUGHT'));
      await predictor.predict({...q,forecast_prompt:'SECOND_QUESTION_CONTEXT'},NullRetrievalEnv,BudgetTier.Unlimited);
      assert.equal(requests[3].messages.length,2);
      assert.doesNotMatch(JSON.stringify(requests[3]),/FIRST_RESULT|FULL_READ_BODY|APPROVED_QUESTION_CONTEXT|THOUGHT/);
    }
  } finally {globalThis.fetch=original;}
});

test("AgenticSearchPredictor records exact prompts, responses and fetched body", async () => {
  const events: TraceEventInput[] = [];
  let call = 0;
  const client: LlmClient = {
    id: "fake:model-v1",
    traceMetadata: { model: "model-v1", temperature: 0 },
    async complete(req: LlmRequest) {
      req.onTrace?.({ type: "http_attempt_started", data: { attempt: 1 } });
      call++;
      if (call === 1) {
        return {
          text: "I should read the primary source.",
          reasoning: "Need evidence before forecasting.",
          costUsd: 0.01,
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 50,
          cacheWriteInputTokens: 30,
          reasoningTokens: 5,
          provider: { requestId: "req-1", model: "model-v1" },
          finishReason: "tool_calls",
          toolCalls: [
            { id: "call-1", name: "web_fetch", args: { url: "https://example.test/a" } },
          ],
        };
      }
      const priorAssistant = req.messages?.find(m=>m.role === "assistant");
      assert.ok(priorAssistant);
      assert.equal(priorAssistant.reasoning, "Need evidence before forecasting.");
      assert.equal("reasoning_content" in priorAssistant, false);
      assert.ok(req.messages!.filter(m => m.role !== "assistant").every(m => !("reasoning" in m)));
      return {
        text: "The evidence raises the chance.\n*0.63*",
        reasoning: "Update from the document.",
        costUsd: 0.02,
        inputTokens: 200,
        outputTokens: 30,
        finishReason: "stop",
      };
    },
  };
  const backend: SearchBackend = {
    name: "fake",
    async search() {
      return [];
    },
    async fetch() {
      return {
        title: "Primary source",
        url: "https://example.test/a",
        body: "EXACT BODY handed to the model, including punctuation.",
        source: "frozen",
        crawlDate: "2026-02-28T00:00:00Z",
      };
    },
    stats() {
      return {};
    },
  };
  const predictor = new AgenticSearchPredictor(client, backend, {
    maxToolCalls: 2,
    trace: { record: (event) => events.push(event) },
  });

  const prediction = await predictor.predict(
    question,
    NullRetrievalEnv,
    BudgetTier.Unlimited,
  );
  assert.equal(prediction.probabilities[0], 0.63);
  assert.equal(prediction.input_tokens, 300);
  assert.equal(events[0]?.type, "agent_started");
  const started = events[0]?.data as { initial_messages: { content: string }[] };
  assert.match(started.initial_messages[0]!.content, /superforecaster/);
  assert.match(started.initial_messages[1]!.content, /Will the test event happen/);

  const assistant = events.filter((e) => e.type === "assistant_message");
  assert.equal(assistant.length, 2);
  assert.equal((assistant[0]!.data as any).usage.cache_write_input_tokens, 30);
  assert.equal((assistant[1]!.data as any).usage.cache_write_input_tokens, null);
  assert.equal((assistant[0]!.data as { reasoning: string }).reasoning, "Need evidence before forecasting.");

  const tool = events.find((e) => e.type === "tool_call_finished");
  assert.ok(tool);
  const toolData = tool.data as { content: string; content_sha256: string };
  assert.deepEqual(JSON.parse(toolData.content), {
    title: "Primary source",
    url: "https://example.test/a",
    text: "EXACT BODY handed to the model, including punctuation.",
  });
  assert.equal(
    predictor.lastTrace[0]?.fetched?.crawlDate,
    "2026-02-28T00:00:00Z",
  );
  assert.match(toolData.content_sha256, /^[a-f0-9]{64}$/);
  assert.equal(events.at(-1)?.type, "agent_finished");
});

test("retrieval audit stores candidate bodies by blob reference without changing tool content", async () => {
  const events: TraceEventInput[] = [];
  const storedBodies: string[] = [];
  let modelSawBody = false;
  let call = 0;
  const client: LlmClient = {
    id: "fake:audit-model",
    async complete(req) {
      call++;
      if (call === 2) {
        modelSawBody = (req.messages ?? []).some(
          (message) => message.role === "tool" && message.content.includes(body),
        );
      }
      return call === 1
        ? {
            text: "",
            costUsd: 0,
            inputTokens: 1,
            outputTokens: 1,
            toolCalls: [{ id: "audit-fetch", name: "web_fetch", args: { url: "https://example.test/a" } }],
            finishReason: "tool_calls",
          }
        : {
            text: "*0.50*",
            costUsd: 0,
            inputTokens: 1,
            outputTokens: 1,
            finishReason: "stop",
          };
    },
  };
  const body = "one full candidate body";
  const backend: SearchBackend = {
    name: "web-filter",
    async search() { return []; },
    async fetch() { return null; },
    async fetchWithTrace(url, asOf) {
      return {
        doc: { title: "Candidate", url, body, source: "web", publishDate: "2026-02-01" },
        audit: {
          schema_version: "raven.retrieval-audit.v1",
          operation: "fetch",
          backend: "web-filter",
          requested_url: url,
          anchor_utc: asOf,
          candidates: [{
            provider_rank: 1,
            url,
            title: "Candidate",
            snippet: "",
            engine_reported_date: null,
            engine_date_decision: "fetch",
            fetch: {
              source: "direct",
              date: "2026-02-01",
              last_modified: null,
              why: "",
              duration_ms: 5,
              body,
            },
            page_date_decision: "accepted",
            final_disposition: "served_to_forecaster",
            served_to_forecaster: true,
          }],
        },
      };
    },
    stats() { return {}; },
  };
  const predictor = new AgenticSearchPredictor(client, backend, {
    maxToolCalls: 1,
    trace: {
      record: (event) => events.push(event),
      storeTextBlob(text) {
        storedBodies.push(text);
        return {
          sha256: "b".repeat(64),
          path: `blobs/${"b".repeat(64)}.txt`,
          bytes: Buffer.byteLength(text),
          chars: text.length,
          encoding: "utf-8",
        };
      },
    },
  });

  await predictor.predict(question, NullRetrievalEnv, BudgetTier.Unlimited);
  assert.deepEqual([...new Set(storedBodies)], [body]);
  const auditEvent = events.find((event) => event.type === "retrieval_audit");
  assert.ok(auditEvent);
  const archived = JSON.stringify(auditEvent.data);
  assert.doesNotMatch(archived, /one full candidate body/);
  assert.match(archived, /blobs\/[a-f0-9]{64}\.txt/);
  const toolEvent = events.find((event) => event.type === "tool_call_finished");
  const toolData = toolEvent?.data as {
    content: null;
    model_visible_content: { text_blob: { path: string } };
  };
  assert.equal(toolData.content, null);
  assert.match(toolData.model_visible_content.text_blob.path, /blobs\/[a-f0-9]{64}\.txt/);
  assert.equal(modelSawBody, true);
});

test("AgenticSearchPredictor preserves a failure event when the final answer is invalid", async () => {
  const events: TraceEventInput[] = [];
  const client: LlmClient = {
    id: "fake:invalid",
    async complete() {
      return {
        text: "I decline to provide a number.",
        costUsd: 0,
        inputTokens: 10,
        outputTokens: 6,
        finishReason: "stop",
      };
    },
  };
  const predictor = new AgenticSearchPredictor(client, undefined, {
    maxToolCalls: 0,
    trace: { record: (event) => events.push(event) },
  });
  await assert.rejects(
    predictor.predict(question, NullRetrievalEnv, BudgetTier.Unlimited),
    /no probability/,
  );
  assert.equal(events.at(-1)?.type, "agent_failed");
  assert.equal(predictor.lastUsage.inputTokens, 10);
});

test("parallel tool calls cannot overshoot the archived execution budget", async () => {
  const events: TraceEventInput[] = [];
  let modelTurn = 0;
  let fetches = 0;
  const client: LlmClient = {
    id: "fake:parallel",
    async complete() {
      modelTurn++;
      if (modelTurn === 1) {
        return {
          text: "",
          costUsd: 0,
          inputTokens: 1,
          outputTokens: 1,
          toolCalls: [
            { id: "a", name: "web_fetch", args: { url: "https://example.test/a" } },
            { id: "b", name: "web_fetch", args: { url: "https://example.test/b" } },
          ],
          finishReason: "tool_calls",
        };
      }
      return {
        text: "*0.50*",
        costUsd: 0,
        inputTokens: 1,
        outputTokens: 1,
        finishReason: "stop",
      };
    },
  };
  const backend: SearchBackend = {
    name: "fake",
    async search() {
      return [];
    },
    async fetch(url) {
      fetches++;
      return { title: url, url, body: url };
    },
    stats() {
      return {};
    },
  };
  const predictor = new AgenticSearchPredictor(client, backend, {
    maxToolCalls: 1,
    trace: { record: (event) => events.push(event) },
  });
  await predictor.predict(question, NullRetrievalEnv, BudgetTier.Unlimited);
  assert.equal(fetches, 1);
  assert.equal(events.filter((event) => event.type === "tool_call_finished").length, 1);
  assert.equal(events.filter((event) => event.type === "tool_call_skipped").length, 1);
  assert.equal(
    predictor.lastTrace.filter((call) => call.outcome !== "budget exhausted; not executed").length,
    1,
  );
});

test("parallel tool calls overlap while traces and tool messages preserve provider order", async () => {
  const events: TraceEventInput[] = [];
  let modelTurn = 0;
  let activeFetches = 0;
  let peakFetches = 0;
  let secondTurnToolIds: (string | undefined)[] = [];
  const client: LlmClient = {
    id: "fake:parallel-overlap",
    async complete(req) {
      modelTurn++;
      if (modelTurn === 1) {
        return {
          text: "",
          costUsd: 0,
          inputTokens: 1,
          outputTokens: 1,
          toolCalls: [
            { id: "slow-a", name: "web_fetch", args: { url: "https://example.test/a" } },
            { id: "fast-b", name: "web_fetch", args: { url: "https://example.test/b" } },
          ],
          finishReason: "tool_calls",
        };
      }
      secondTurnToolIds = (req.messages ?? [])
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId);
      return {
        text: "*0.50*",
        costUsd: 0,
        inputTokens: 1,
        outputTokens: 1,
        finishReason: "stop",
      };
    },
  };
  const backend: SearchBackend = {
    name: "fake",
    async search() {
      return [];
    },
    async fetch(url) {
      activeFetches++;
      peakFetches = Math.max(peakFetches, activeFetches);
      await new Promise((resolve) => setTimeout(resolve, url.endsWith("/a") ? 20 : 5));
      activeFetches--;
      return { title: url, url, body: url };
    },
    stats() {
      return {};
    },
  };
  const predictor = new AgenticSearchPredictor(client, backend, {
    maxToolCalls: 2,
    trace: { record: (event) => events.push(event) },
  });

  await predictor.predict(question, NullRetrievalEnv, BudgetTier.Unlimited);
  assert.equal(peakFetches, 2);
  assert.deepEqual(secondTurnToolIds, ["slow-a", "fast-b"]);
  assert.deepEqual(
    predictor.lastTrace.map((call) => call.call_id),
    ["slow-a", "fast-b"],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "tool_call_finished")
      .map((event) => (event.data as { call_id: string }).call_id),
    ["fast-b", "slow-a"],
  );
});

test("AgenticSearchPredictor records then propagates shared retrieval failures", async () => {
  const events: TraceEventInput[] = [];
  let modelCalls = 0;
  const client: LlmClient = {
    id: "fake:retrieval-failure",
    async complete() {
      modelCalls++;
      return {
        text: "Need current evidence.",
        costUsd: 0.01,
        inputTokens: 20,
        outputTokens: 5,
        toolCalls: [
          { id: "search-1", name: "web_search", args: { query: "fixture" } },
        ],
        finishReason: "tool_calls",
      };
    },
  };
  const backend: SearchBackend = {
    name: "web-filter",
    async search() {
      throw new RetrievalInfrastructureError(
        "page-dater",
        "helper_exit",
        "fixture helper stopped",
      );
    },
    async fetch() {
      return null;
    },
    stats() {
      return {};
    },
  };
  const predictor = new AgenticSearchPredictor(client, backend, {
    maxToolCalls: 5,
    trace: { record: (event) => events.push(event) },
  });

  await assert.rejects(
    predictor.predict(question, NullRetrievalEnv, BudgetTier.Unlimited),
    (error: unknown) =>
      error instanceof RetrievalInfrastructureError &&
      error.component === "page-dater" &&
      error.code === "helper_exit",
  );
  assert.equal(modelCalls, 1);
  assert.equal(events.filter((event) => event.type === "tool_call_error").length, 1);
  assert.equal(events.at(-1)?.type, "agent_failed");
  assert.equal(predictor.lastTrace.length, 1);
  assert.equal(predictor.lastTrace[0]?.outcome, "tool execution failed");
});

test("AgenticSearchPredictor archives the exact Web-filter search funnel", async () => {
  const events: TraceEventInput[] = [];
  let modelCalls = 0;
  const funnel = {
    backend: "web-filter",
    provider: "fixture",
    anchor_utc: "2026-01-01T00:00:00Z",
    provider_date_cutoff: "2025-12-31",
    page_date_policy: "calendar-day-must-end-before-anchor" as const,
    provider_failed: false,
    requested_results: 10,
    provider_hits: 20,
    engine_date_dropped: 3,
    engine_same_day_rejected: 2,
    candidates_to_page_dater: 17,
    page_records: 17,
    pages_dated_pre_anchor: 8,
    pages_undated: 6,
    pages_post_anchor_or_invalid: 3,
    pages_same_day_rejected: 2,
    pages_blocked_with_snippet: 2,
    leak_reviews: 8,
    leak_review_attempts: 8,
    leak_dropped: 1,
    leak_cache_hits: 0,
    leak_review_failed: 0,
    leak_cost_usd: 0.004,
    served: 7,
  };
  const client: LlmClient = {
    id: "fake:funnel",
    async complete() {
      modelCalls++;
      if (modelCalls === 1) {
        return {
          text: "Search first.",
          costUsd: 0,
          inputTokens: 1,
          outputTokens: 1,
          toolCalls: [
            { id: "search-1", name: "web_search", args: { query: "fixture" } },
          ],
          finishReason: "tool_calls",
        };
      }
      return {
        text: "*0.50*",
        costUsd: 0,
        inputTokens: 1,
        outputTokens: 1,
        finishReason: "stop",
      };
    },
  };
  const backend: SearchBackend = {
    name: "web-filter",
    async search() {
      throw new Error("searchWithTrace should be used");
    },
    async searchWithTrace() {
      return {
        results: [
          {
            title: "fixture",
            url: "https://example.test/funnel",
            snippet: "fixture",
            source: "web" as const,
          },
        ],
        funnel,
      };
    },
    async fetch() {
      return null;
    },
    stats() {
      return {};
    },
  };
  const predictor = new AgenticSearchPredictor(client, backend, {
    maxToolCalls: 2,
    trace: { record: (event) => events.push(event) },
  });

  await predictor.predict(question, NullRetrievalEnv, BudgetTier.Unlimited);
  assert.deepEqual(predictor.lastTrace[0]?.funnel, funnel);
  const finished = events.find((event) => event.type === "tool_call_finished");
  assert.deepEqual(
    (finished?.data as { funnel?: unknown } | undefined)?.funnel,
    funnel,
  );
});
