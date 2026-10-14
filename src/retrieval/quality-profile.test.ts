import test from 'node:test';
import assert from 'node:assert/strict';
import { retrievalProfile, assertQualityCorpus } from './quality-profile.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EvidenceStore, DocumentReader, EvidenceReviewer, QualityWebBackend, CorpusStore, createRetrievalRuntime } from '../../vendor/retrieval-infra/src/index.js';
import type { SearchProvider } from './search-providers.js';
import { AgenticSearchPredictor } from '../predictors/agentic-search.js';
import { BudgetTier, NullRetrievalEnv } from '../predictors/types.js';
import { defaultFrozenWorkers } from '../../vendor/retrieval-infra/src/corpus/frozen-execution.js';
import type { Question } from '../types.js';

test('current retrieval is the default and rejects incompatible legacy switches', () => {
  assert.equal(retrievalProfile(['--shared-frozen-cache','/tmp/frozen.db'],'/tmp/evidence').sharedFrozenCachePath,'/tmp/frozen.db');
  assert.equal(retrievalProfile(['--shared-frozen-cache','/tmp/frozen.db','--frozen-global-slots','28'],'/tmp/evidence').sharedFrozenCacheSlots,28);
  assert.throws(()=>retrievalProfile(['--frozen-global-slots','4'],'/tmp/evidence'));
  assert.throws(()=>retrievalProfile(['--shared-frozen-cache','/tmp/frozen.db','--frozen-global-slots','33'],'/tmp/evidence'));
  assert.throws(()=>retrievalProfile(['--shared-frozen-cache','/tmp/frozen.db','--retrieval-profile','baseline'],'/tmp/evidence'));
  assert.equal(retrievalProfile([], '/tmp/evidence').frozenWorkers,defaultFrozenWorkers());
  for(const workers of [1,4,8])assert.equal(retrievalProfile(['--frozen-workers',String(workers)],'/tmp/evidence').frozenWorkers,workers);
  assert.equal(retrievalProfile(['--shared-page-cache','/tmp/pages','--shared-review-cache','/tmp/reviews'],'/tmp/evidence').sharedPageCacheDirectory,'/tmp/pages');
  assert.throws(()=>retrievalProfile(['--shared-page-cache','/tmp/pages'],'/tmp/evidence'));
  assert.throws(()=>retrievalProfile(['--shared-page-cache','/tmp/pages','--shared-review-cache','/tmp/reviews','--fixed-document-manifest','/tmp/fixed.json'],'/tmp/evidence'));
  assert.equal(retrievalProfile(['--search-concurrency','32'],'/tmp/evidence').searchHttpConcurrency,32);
  assert.equal(retrievalProfile(['--leak-fallback-llm','deepseek:deepseek-flash','--search-delivery','summary'], '/tmp/evidence').searchDelivery,'summary');
  assert.throws(()=>retrievalProfile(['--search-delivery','summary','--content-processing','whole-document'],'/tmp/evidence'));
  assert.equal(retrievalProfile([], '/tmp/synthetic-evidence').enabled, true);
  assert.equal(retrievalProfile([], '/tmp/synthetic-evidence').contentProcessing, 'single-pass');
  assert.equal(retrievalProfile(['--review-concurrency','256'], '/tmp/synthetic-evidence').reviewConcurrency,256);
  assert.throws(()=>retrievalProfile(['--review-concurrency','0'], '/tmp/synthetic-evidence'));
  assert.throws(() => retrievalProfile(['--content-processing','whole-document','--source-manifest','/tmp/sources.json'], '/tmp/evidence'));
  assert.equal(retrievalProfile(['--source-manifest','/tmp/sources.json'], '/tmp/evidence').sourceManifestFile, '/tmp/sources.json');
  assert.equal(retrievalProfile(['--retrieval-profile','baseline'], '/tmp/synthetic-evidence').enabled, false);
  assert.equal(retrievalProfile(['--retrieval-profile', 'quality-v1'], '/tmp/synthetic-evidence').enabled, true);
  for (const args of [
    ['--retrieval-profile','baseline','--retrieval-evidence-dir', '/tmp/synthetic-evidence'],
    ['--retrieval-profile', 'quality-v1', '--date-gate', 'strict'],
    ['--retrieval-profile', 'quality-v1', '--fetch-chars', '260'],
    ['--retrieval-profile', 'quality-v1', '--leak-filter', '0'],
    ['--retrieval-profile'],
  ]) assert.throws(() => retrievalProfile(args, '/tmp/synthetic-evidence'));
});

test('quality frozen admission rejects a live-statistics corpus or a mismatched exact anchor', () => {
  assert.throws(() => assertQualityCorpus({ kind: 'ordinary-sqlite-corpus' }, ['2026-03-01T00:00:00Z']));
  const corpus = { kind: 'historical-fts-index', anchor: '2026-03-01T00:00:00.000Z' };
  assertQualityCorpus(corpus, ['2026-03-01T08:00:00+08:00']);
  assert.throws(() => assertQualityCorpus(corpus, ['2026-03-01T00:00:01Z']));
});

test('benchmark search and fetch receive the same full historical article, with current SERP metadata isolated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-bench-'));
  try {
    const artifacts = new EvidenceStore(directory);
    const body = "'''Synthetic observatory'''\n" + 'Historical observations and methodology. '.repeat(1400) + 'FINAL HISTORICAL NOTE';
    const raw = JSON.stringify({ query: { pages: [{ pageid: 1, revisions: [{ revid: 42, timestamp: '2026-02-01T00:00:00Z',
      sha1: createHash('sha1').update(body).digest('hex'), slots: { main: { content: body, contentmodel: 'wikitext' } } }] }] } });
    const reader = new DocumentReader(async () => { throw new Error('live-page fallback must not run'); }, artifacts, async () => raw);
    const provider: SearchProvider = { name: 'synthetic', async search() { return [{ url: 'https://en.wikipedia.org/wiki/Synthetic', title: 'FUTURE SERP TITLE', snippet: 'FUTURE SERP OUTCOME' }]; }, stats() { return { requests: 1, failed: 0 }; } };
    const reviewer = new EvidenceReviewer({ id: 'synthetic:reviewer', async complete() { throw new Error('verified historical revision needs no model guess'); } }, provider, reader, artifacts);
    const backend = new QualityWebBackend(provider, reader, reviewer, artifacts);
    let calls = 0;
    const predictor = new AgenticSearchPredictor({ id: 'synthetic:forecaster', async complete(request) {
      calls++;
      if (calls > 1) {
        const text = request.messages!.filter(m => m.role === 'tool').at(-1)!.content;
        assert.ok(text.includes('FINAL HISTORICAL NOTE'));
        assert.ok(text.length > 40000);
        assert.doesNotMatch(text, /FUTURE SERP/);
      }
      const common = { text: '*0.5*', costUsd: 0, inputTokens: 1, outputTokens: 1 };
      if (calls === 1) return { ...common, toolCalls: [{ id: 'search-1', name: 'web_search', args: { query: 'Synthetic observatory' } }] };
      if (calls === 2) return { ...common, toolCalls: [{ id: 'fetch-1', name: 'web_fetch', args: { url: 'https://en.wikipedia.org/w/index.php?oldid=42' } }] };
      return common;
    } }, backend, { maxToolCalls: 3, fetchChars: 0 });
    const question: Question = { question_id: 'synthetic-quality', question_text: 'Will an observation be announced?', resolution_criteria: 'Yes if announced by deadline.',
      as_of_date: '2026-03-01T00:00:00Z', resolution_date: '2026-04-01T00:00:00Z', ground_truth: 1,
      market_price_at_freeze: null, category: 'test', difficulty_level: 'easy', source: 'unit', language: 'en' };
    await predictor.predict(question, NullRetrievalEnv, BudgetTier.Unlimited);
    assert.equal(calls, 3);
    assert.equal(reviewer.snapshot().modelCalls, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('the benchmark agent can page entity captures through the shared runtime beyond ordinary top-k', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browse-bench-'));
  const store = new CorpusStore(':memory:','concept');
  try {
    store.ingest(Array.from({length:24},(_,i)=>({url:`https://example.org/capture/${i}`,title:`Acme capture ${i}`,
      body:i===0?'Acme complete transcript with the oldest decisive passage.':'Acme routine update.',
      crawlDate:`2026-02-${String(i+1).padStart(2,'0')}T00:00:00Z`})).concat([
        {url:'https://example.org/future',title:'Acme future',body:'Acme future answer',crawlDate:'2026-03-02T00:00:00Z'}]));
    const runtime = createRetrievalRuntime({store,evidenceDirectory:directory});
    const backend = runtime.createBackend('frozen');
    let calls=0; let cursor:string|undefined;
    const predictor=new AgenticSearchPredictor({id:'synthetic:browse',async complete(request){
      calls++;
      const common={text:'*0.5*',costUsd:0,inputTokens:1,outputTokens:1};
      if(calls===1) {
        const schema=request.tools!.find(t=>t.name==='web_search')!.parameters;
        assert.ok(JSON.stringify(schema).includes('entity'));
      } else {
        const returned=JSON.parse(request.messages!.filter(m=>m.role==='tool').at(-1)!.content);
        assert.ok(returned.results.every((r:any)=>!r.url.includes('future')));
        cursor=returned.next_cursor;
        if(calls===4) {
          assert.equal(cursor,null); assert.equal(returned.results.length,4);
          assert.ok(returned.results.some((r:any)=>r.snippet.includes('oldest decisive passage')));
          return common;
        }
        assert.ok(cursor);
      }
      return {...common,toolCalls:[{id:`browse-${calls}`,name:'web_search',args:{entity:'Acme',since:'2026-02-01',num_results:10,...(cursor?{cursor}:{})}}]};
    }},backend,{maxToolCalls:3,fetchChars:0});
    await predictor.predict({question_id:'browse-unit',question_text:'Will Acme report a change?',resolution_criteria:'An announcement.',
      as_of_date:'2026-03-01T00:00:00Z',resolution_date:'2026-04-01T00:00:00Z',ground_truth:1,
      market_price_at_freeze:null,category:'test',difficulty_level:'easy',source:'unit',language:'en'},NullRetrievalEnv,BudgetTier.Unlimited);
    assert.equal(calls,4);runtime.close();
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('disk Wiki index requires its fixed manifest and forwards an absolute path',()=>{
  assert.throws(()=>retrievalProfile(['--wiki-index','/tmp/wiki-fts.db'],'/tmp/evidence'),/requires --wiki-manifest/);
  const profile=retrievalProfile(['--wiki-cache','/tmp/wiki-cache.db','--wiki-manifest','/tmp/wiki.json','--wiki-index','/tmp/wiki-fts.db'],'/tmp/evidence');
  assert.equal(profile.wikiIndexFile,'/tmp/wiki-fts.db');
});
