import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRetrievalRuntime } from './runtime.js';
import { createRetrievalSession } from './session.js';
import { CorpusStore } from '../corpus/store.js';
import { buildFrozenIndex } from '../corpus/frozen-index.js';

test('browser acquisition is an explicit opt-in and changes the recorded acquisition condition',()=>{
  const directory=mkdtempSync(join(tmpdir(),'retrieval-browser-options-'));
  const base=createRetrievalRuntime({evidenceDirectory:join(directory,'base')});
  const browser=createRetrievalRuntime({evidenceDirectory:join(directory,'browser'),browser:true});
  try {assert.equal(base.dater.configuration().browser,false);assert.notEqual(browser.dater.configuration().browser,false);}
  finally {base.close();browser.close();rmSync(directory,{recursive:true,force:true});}
});

// This tests the seam used by the experiment harness against the public API;
// neither entry is allowed to fall back to the old top-k/snippet implementation.
test('shared runtime and public session return identical full captured text and paginated membership', async () => {
  const directory=mkdtempSync(join(tmpdir(),'retrieval-runtime-'));
  const anchor='2026-03-01T00:00:00Z';
  let store:CorpusStore|undefined;
  try {
    const source=join(directory,'source.db'),index=join(directory,'index.db');
    store=new CorpusStore(source,'rarity','write');
    const body='Orion fiscal year 2026 report. '+'Historical measurement details and original units. '.repeat(50);
    store.ingest([{url:'https://example.test/orion',title:'Orion report',body,crawlDate:'2026-02-03T00:00:00Z'}]);store.close();store=undefined;
    await buildFrozenIndex(source,index,anchor,{minimumFreeBytes:0});
    store=new CorpusStore(index,'concept','auto');
    const runtime=createRetrievalRuntime({store,evidenceDirectory:join(directory,'runtime')});
    const backend=runtime.createBackend('frozen');
    const session=createRetrievalSession({mode:'frozen',asOf:anchor,corpusPath:index,evidenceDirectory:join(directory,'session')});
    try {
      const direct=await backend.search('Orion FY2026',10,anchor);
      assert.deepEqual(direct,await session.search('Orion FY2026',10));
      assert.equal(direct[0]?.snippet,body);
      assert.ok(backend.browse);
      assert.deepEqual(await backend.browse({entity:'Orion'},anchor),await session.browse({entity:'Orion'}));
      assert.throws(()=>runtime.createBackend('web-filter'),/search provider and reviewer client/);
    } finally { session.close();runtime.close(); }
    // Closing the runtime must not close the experiment harness's injected store.
    assert.equal(store.browse({entity:'Orion'},anchor).results.length,1);
    assert.throws(()=>runtime.createBackend('frozen'),/closed/);
  } finally { store?.close();rmSync(directory,{recursive:true,force:true}); }
});

test('concurrent question contexts keep independently selected versions of the same captured URL', async () => {
  const directory=mkdtempSync(join(tmpdir(),'retrieval-runtime-context-'));
  const anchor='2026-03-01T00:00:00Z',url='https://example.test/orion/report';
  const oldBody='Archivaltranscript original full report. '+'Unabridged historical statement. '.repeat(40);
  const newBody='Updatepreview shortened capture.';
  const store=new CorpusStore(join(directory,'source.db'),'concept','write');
  const runtime=createRetrievalRuntime({store,evidenceDirectory:join(directory,'evidence')});
  try {
    store.ingest([{url,title:'Archivaltranscript',body:oldBody,crawlDate:'2026-01-01T00:00:00Z'},
      {url,title:'Updatepreview',body:newBody,crawlDate:'2026-02-01T00:00:00Z'}]);
    const backend=runtime.createBackend('frozen');
    const first={question:'First question'},second={question:'Second question'};
    await Promise.all([backend.searchWithTrace('Archivaltranscript',1,anchor,first),backend.searchWithTrace('Updatepreview',1,anchor,second)]);
    const docs=await Promise.all([backend.fetchWithTrace(url,anchor,first),backend.fetchWithTrace(url,anchor,second)]);
    assert.equal(docs[0]?.doc?.body,oldBody);assert.equal(docs[1]?.doc?.body,newBody);
    const third={question:'Third question'};
    const page=await backend.browse({entity:'Archivaltranscript',until:'2026-01-31'},anchor,third);
    assert.equal(page.results[0]?.body,oldBody);
    assert.equal((await backend.fetchWithTrace(url,anchor,third)).doc?.body,oldBody);
    assert.equal((await backend.fetchWithTrace(url,anchor,second)).doc?.body,newBody);
  } finally { runtime.close();store.close();rmSync(directory,{recursive:true,force:true}); }
});

test('web runtime uses primary verdict even when shadow admits the same candidate',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'runtime-shadow-'));
  const requests: Record<string,unknown[]>={high:[],low:[]};
  const client=(effort:'high'|'low')=>({id:'fixture:'+effort,traceMetadata:{effort},async complete(request:unknown){
    requests[effort]!.push(request);
    return {text:JSON.stringify({status:effort==='high'?'leaked':'supported',reason:'fixture temporal decision',remove:[],evidenceIds:[]}),
      costUsd:effort==='high'?0.02:0.01,inputTokens:10,outputTokens:5};
  }});
  const provider={name:'fixture',async search(){return [];},stats:()=>({requests:0,failed:0})};
  const runtime=createRetrievalRuntime({evidenceDirectory:directory,provider,reviewerClient:client('high'),shadowReviewerClient:client('low')});
  try {
    const {sha256}=await import('../retrieval/evidence-store.js');
    const body='An article with later results.';
    const page={url:'https://example.test/report',title:'Report',body,bodySha256:sha256(body),
      acquiredAt:'2026-09-19T00:00:00Z',publishedDate:'2026-06-01',temporalBasis:'live-page' as const,provenanceId:'fixture'};
    const id=runtime.artifacts.put(page);
    runtime.reader.read=async()=>({...page,id});
    const backend=runtime.createBackend('web-filter');
    assert.equal(await backend.fetch(page.url,'2026-07-01T00:00:00Z'),null);
    assert.equal(requests.high!.length,1);assert.equal(requests.low!.length,1);
    assert.deepEqual((requests.high![0] as any).messages,(requests.low![0] as any).messages);
    assert.equal(runtime.reviewer!.snapshot().costUsd,0.02);
    assert.equal(runtime.shadowReviewer!.snapshot().costUsd,0.01);
    assert.equal(await backend.fetch(page.url,'2026-07-01T00:00:00Z'),null);
    assert.equal(requests.high!.length,1);assert.equal(requests.low!.length,1);
  } finally {runtime.close();rmSync(directory,{recursive:true,force:true});}
});

test('shadow later-turn failure retains earlier billed usage and effort trace identity',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'runtime-shadow-partial-'));
  let lowCalls=0;
  const primary={id:'fixture',traceMetadata:{effort:'high'},async complete(){return {
    text:JSON.stringify({status:'supported',reason:'Historical article',remove:[],evidenceIds:[]}),costUsd:0.02,inputTokens:10,outputTokens:5};}};
  const shadow={id:'fixture',traceMetadata:{effort:'low'},async complete(){
    if(++lowCalls===2)throw new Error('later transport failure');
    return {text:'',costUsd:0.01,inputTokens:10,outputTokens:5,finishReason:'tool_calls',
      toolCalls:[{id:'find',name:'search_evidence',args:{query:'article date',scope:'historical'}}]};
  }};
  const provider={name:'fixture',async search(){return [];},stats:()=>({requests:1,failed:0})};
  const runtime=createRetrievalRuntime({evidenceDirectory:directory,provider,reviewerClient:primary,shadowReviewerClient:shadow,reviewOptions:{searchDelivery:'fulltext'}});
  try {
    const {sha256}=await import('../retrieval/evidence-store.js');
    const body='An article published before the cutoff.';
    const page={url:'https://example.test/history',title:'Report',body,bodySha256:sha256(body),
      acquiredAt:'2026-09-19T00:00:00Z',publishedDate:'2026-06-01',temporalBasis:'live-page' as const,provenanceId:'fixture'};
    const id=runtime.artifacts.put(page);runtime.reader.read=async()=>({...page,id});
    assert.equal((await runtime.createBackend('web-filter').fetch(page.url,'2026-07-01T00:00:00Z'))?.body,body);
    assert.equal(lowCalls,2);assert.equal(runtime.shadowReviewer!.snapshot().costUsd,0.01);
    assert.equal(runtime.shadowReviewer!.snapshot().modelCalls,2);
    assert.equal(runtime.reviewer!.snapshot().costUsd,0.02);
    const requests=readdirSync(directory).filter(x=>x.endsWith('.json')).map(x=>JSON.parse(readFileSync(join(directory,x),'utf8'))).filter(x=>x.request);
    assert.deepEqual(requests.map(x=>x.client.metadata.effort).sort(),['high','low','low']);
    assert.equal(JSON.parse(readFileSync(join(directory,'paired-review/index.jsonl'),'utf8')).candidateId,id);
  } finally {runtime.close();rmSync(directory,{recursive:true,force:true});}
});
