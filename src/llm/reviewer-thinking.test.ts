import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAiCompatibleClient } from './openai-compatible.js';
import { configureReviewerThinking, configureReviewerEffort } from './reviewer-thinking.js';
import { EvidenceReviewer } from '../../vendor/retrieval-infra/src/retrieval/evidence-reviewer.js';
import { EvidenceStore } from '../../vendor/retrieval-infra/src/retrieval/evidence-store.js';
import { DocumentReader } from '../../vendor/retrieval-infra/src/retrieval/document-reader.js';

test('review thinking changes the reviewer wire request and cache identity while retaining the prediction default and budget', async () => {
  const originalFetch = globalThis.fetch, requests: any[] = [];
  const directory = mkdtempSync(join(tmpdir(), 'fabench-review-thinking-'));
  const client = new OpenAiCompatibleClient({ providerId: 'deepseek', model: 'deepseek-flash',
    apiKey: 'fixture', baseUrl: 'https://api.deepseek.com/v1',
    admission: { async acquire() { return { limited() {}, release() {} }; } } });
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('data: '+JSON.stringify({choices:[{delta:{content:'{}'},finish_reason:'stop'}],
      usage:{prompt_tokens:10,completion_tokens:2}})+'\n\ndata: [DONE]\n\n',
      {headers:{'content-type':'text/event-stream'}});
  };
  try {
    const on = configureReviewerThinking(client, 'enabled');
    const off = configureReviewerThinking(client, 'disabled');
    assert.equal(on, client);
    assert.equal(configureReviewerThinking(client), client);
    assert.equal(off.traceMetadata?.max_tokens, client.traceMetadata.max_tokens);
    assert.equal(off.traceMetadata?.max_tokens_source, 'provider-model-maximum');
    const req = {prompt:'page',tools:[{name:'search_evidence',description:'date lookup',parameters:{type:'object'}}]};
    await off.complete(req); await on.complete(req); await client.complete(req);
    assert.deepEqual(requests[0].thinking, {type:'disabled'});
    assert.equal(requests[1].thinking, undefined, 'enabled preserves the historical native provider default');
    assert.deepEqual(requests[1], requests[2], 'predictor using the original client is unchanged');
    const {thinking, ...other} = requests[0];
    assert.deepEqual(other, requests[1], 'only the reviewer thinking parameter changes');
    const artifacts = new EvidenceStore(directory);
    const reader = new DocumentReader(async () => [], artifacts);
    const provider = {name:'fixture',async search(){return [];},stats:()=>({requests:0,failed:0})};
    const config = (c: typeof on) => new EvidenceReviewer(c, provider, reader, artifacts,
      {processing:'single-pass',searchDelivery:'summary'}).semanticConfiguration();
    assert.deepEqual(config(on), config(client));
    assert.notDeepEqual(config(off), config(on), 'review cache identities must separate the two settings');
    assert.equal(config(off).system_sha256, config(on).system_sha256);
    assert.equal(config(off).maxModelCalls, config(on).maxModelCalls);
    assert.throws(() => configureReviewerThinking(off, 'enabled'), /already has thinking disabled/);
  } finally { globalThis.fetch = originalFetch; rmSync(directory, {recursive:true,force:true}); }
});

test('review effort binds every tool turn and final answer, separates cache identity, and leaves prediction requests unchanged', async () => {
  const originalFetch = globalThis.fetch, requests: any[] = [];
  const directory = mkdtempSync(join(tmpdir(), 'fabench-review-effort-'));
  const client = new OpenAiCompatibleClient({ providerId: 'deepseek', model: 'deepseek-flash',
    apiKey: 'fixture', baseUrl: 'https://api.deepseek.com/v1',
    admission: { async acquire() { return { limited() {}, release() {} }; } } });
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('data: '+JSON.stringify({choices:[{delta:{content:'{}'},finish_reason:'stop'}],
      usage:{prompt_tokens:10,completion_tokens:2}})+'\n\ndata: [DONE]\n\n',
      {headers:{'content-type':'text/event-stream'}});
  };
  try {
    const low = configureReviewerEffort(client, 'low'), high = configureReviewerEffort(client, 'high');
    assert.equal(configureReviewerEffort(client), client);
    const conversation = low.startConversation!();
    const req = {prompt:'page',tools:[{name:'search_evidence',description:'date lookup',parameters:{type:'object'}}]};
    await conversation.complete(req);
    await conversation.complete({...req, messages:[{role:'user',content:'page'},
      {role:'assistant',content:'',reasoning:'date check',toolCalls:[{id:'call1',name:'search_evidence',args:{}}]},
      {role:'tool',content:'dated evidence',toolCallId:'call1'}]});
    await conversation.complete({prompt:'final answer'});
    await high.complete(req); await client.complete(req);
    assert.deepEqual(requests.map(r=>r.reasoning_effort), ['low','low','low','high',undefined]);
    assert.equal(requests[1].messages[1].reasoning_content,'date check');
    assert.equal(low.traceMetadata?.max_tokens,client.traceMetadata.max_tokens);
    for (const [index, effort] of [[0,'low'],[3,'high']] as const) {
      const {reasoning_effort, ...other} = requests[index];
      assert.equal(reasoning_effort,effort);assert.deepEqual(other,requests[4]);
    }
    const artifacts = new EvidenceStore(directory), reader = new DocumentReader(async () => [], artifacts);
    const provider = {name:'fixture',async search(){return [];},stats:()=>({requests:0,failed:0})};
    const config = (c: typeof low) => new EvidenceReviewer(c, provider, reader, artifacts,
      {processing:'single-pass',searchDelivery:'summary'}).semanticConfiguration();
    assert.notDeepEqual(config(low),config(high));
    assert.equal(config(low).system_sha256,config(high).system_sha256);
    assert.equal(config(low).maxModelCalls,config(high).maxModelCalls);
    assert.equal(low.reasoningConfiguration!().api_parameters.reasoning_effort,'low');
    assert.equal(high.reasoningConfiguration!().api_parameters.reasoning_effort,'high');
    assert.equal(client.reasoningConfiguration().api_parameters.reasoning_effort,undefined);
    assert.throws(()=>configureReviewerEffort(configureReviewerThinking(client,'disabled'),'low'),/disabled/);
  } finally { globalThis.fetch = originalFetch; rmSync(directory, {recursive:true,force:true}); }
});
