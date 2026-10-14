import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MixedBackend} from './mixed-backend.js';
import {QualityWebBackend, webExecutionPolicy} from './quality-backend.js';
import {EvidenceStore} from './evidence-store.js';
import type {SearchBackend} from './search-backend.js';

const anchor='2026-07-01T00:00:00Z';
function fixture(t: any, reject: number[] = [], fixed = true) {
  const directory=mkdtempSync(join(tmpdir(),'mixed-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const artifacts=new EvidenceStore(directory), requested:number[]=[], read:number[]=[], reviewed:number[]=[], contexts:any[]=[];
  const hits=Array.from({length:20},(_,i)=>({url:`https://example.test/${i+1}`,title:`article ${i+1}`}));
  const provider={name:'synthetic',async search(_q:string,n:number){requested.push(n);return hits;},stats:()=>({requests:requested.length,failed:0})};
  const reader={async read(url:string){const n=Number(url.split('/').at(-1));read.push(n);return {id:String(n),url,title:`article ${n}`,body:`body ${n}`,publishedDate:'2026-06-01'};}};
  const reviewer={searchDelivery:'fulltext',async review(doc:any,_asof:string,ctx:any){const n=Number(doc.id);reviewed.push(n);contexts.push(ctx);return {status:reject.includes(n)?'unknown':'supported',costUsd:0,modelCalls:1,searchCalls:0,readCalls:0,cacheHit:false,receiptId:`r${n}`};}};
  const web=new QualityWebBackend(provider,reader as any,reviewer as any,artifacts,0,{candidateConcurrency:8,fixedCandidatePrefix:fixed});
  const frozenCounts:number[]=[],frozenContexts:any[]=[];
  const frozen:SearchBackend={name:'frozen',fullTextResults:true,stats:()=>({}),async search(){throw Error('context path required');},async searchWithTrace(_q,n,_a,ctx){frozenCounts.push(n);frozenContexts.push(ctx);return {results:Array.from({length:n},(_,i)=>({title:`capture ${i}`,url:`https://archive.test/${i}`,snippet:`capture body ${i}`,source:'frozen' as const}))};},async fetch(url){return {url,title:'capture',body:'frozen body',source:'frozen'};}};
  return {directory,artifacts,requested,read,reviewed,contexts,web,frozen,frozenCounts,frozenContexts,mixed:new MixedBackend(frozen,web,artifacts),hits};
}

test('fixed web prefix is selected before review; rejected pages and excess provider hits never refill',async t=>{
  const f=fixture(t,[1,2,3]);const context={question:'question',resolutionCriteria:'rules'};
  const result=await f.mixed.searchWithTrace('query',10,anchor,context);
  assert.deepEqual(f.requested,[5]);assert.deepEqual(f.frozenCounts,[5]);
  assert.deepEqual(f.read,[1,2,3,4,5]);assert.deepEqual(f.reviewed,[1,2,3,4,5]);
  assert.ok(f.contexts.every(c=>c===context));assert.deepEqual(f.frozenContexts,[context]);
  assert.equal(result.results.length,7);assert.deepEqual(result.results.slice(5).map(r=>r.url),f.hits.slice(3,5).map(r=>r.url));
  assert.equal(result.funnel?.leak_dropped,3);assert.equal(result.funnel?.served,2);
  assert.equal(f.mixed.stats().web_candidates_requested,5);
});

test('all web rejections still return frozen; odd quotas favor frozen; n=1 makes no web call',async t=>{
  const f=fixture(t,[1,2,3,4,5]);
  assert.equal((await f.mixed.search('q',10,anchor)).length,5);
  assert.equal((await f.mixed.search('q',5,anchor)).length,3);
  assert.equal((await f.mixed.search('q',1,anchor)).length,1);
  assert.deepEqual(f.requested,[5,2]);assert.deepEqual(f.frozenCounts,[5,3,1]);
  await assert.rejects(f.mixed.search('q',1.5,anchor),/positive integer/);
});

test('ordinary web-filter retains its larger candidate pool and refill behavior',async t=>{
  const f=fixture(t,[1,2,3],false);
  const result=await f.web.search('q',5,anchor);
  assert.deepEqual(f.requested,[10]);assert.equal(result.length,5);
  assert.deepEqual(result.map(r=>r.url),f.hits.slice(3,8).map(r=>r.url));
  assert.equal(webExecutionPolicy().candidate_selection,undefined);
});

test('cross-source URL duplicates prefer frozen without refill and fetch routes to the returned source',async t=>{
  const f=fixture(t);f.hits[0]!.url='https://archive.test/0';
  const context={question:'q'};
  const result=await f.mixed.searchWithTrace('query',4,anchor,context);
  assert.equal(result.results.length,3);assert.equal(f.mixed.stats().cross_source_duplicates,1);
  assert.equal(result.audit?.candidates[0]?.served_to_forecaster,false);
  assert.equal(result.audit?.candidates[0]?.final_disposition,'duplicate_content');
  assert.equal((await f.mixed.fetchWithTrace('https://archive.test/0',anchor,context)).doc?.source,'frozen');
  const live=await f.mixed.fetchWithTrace('https://example.test/2',anchor,context);
  assert.equal(live.doc?.source,'web');assert.equal(live.doc?.body,'body 2');
});

test('both branches start together and a fatal failure drains the other branch before escaping',async t=>{
  const f=fixture(t);let finish!:()=>void,finished=false;
  f.frozen.searchWithTrace=async()=>{await new Promise<void>(resolve=>{finish=resolve;});finished=true;return {results:[]};};
  f.web.searchWithTrace=async()=>{assert.ok(finish);finish();throw Error('provider failed');};
  await assert.rejects(f.mixed.search('q',10,anchor),/provider failed/);assert.equal(finished,true);
});

test('short frozen results never transfer quota to web and duplicate prefix hits never expose lower ranks',async t=>{
  const f=fixture(t);f.hits[1]=f.hits[0]!;
  f.frozen.searchWithTrace=async()=>({results:[]});
  const result=await f.mixed.search('q',6,anchor);
  assert.deepEqual(f.requested,[3]);assert.deepEqual(f.read,[1,3]);
  assert.equal(result.length,2);assert.ok(!f.read.includes(4));
});
