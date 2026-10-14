import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ArchiveSupplementBackend, type VerifiedArchiveDocument } from './archive-supplement.js';
const anchor='2026-03-01T00:00:00Z';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const doc=(id:string,body:string,date='2026-02-13T16:42:33Z'):VerifiedArchiveDocument=>({url:'https://fred.stlouisfed.org/series/'+id,title:id,body,crawlDate:date,source:'cc-main',capture_proof:{text_sha256:hash(body),document_sha256:hash(JSON.stringify(['https://fred.stlouisfed.org/series/'+id,id,body,date])),warc_record_id:'fixture',cdx_digest:'fixture'}});
test('preserves exact series identity and serves captured history for a future-month query',async()=>{
 const a=doc('USEPUINDXD','Economic Policy Uncertainty Index USEPUINDXD. 2026-02-12: 492.91.'),b=doc('T5YIFR','T5YIFR. Inflation expectation, 2026-02-12: 2.20. Related series: Economic Policy Uncertainty Index USEPUINDXD.');
 const backend=new ArchiveSupplementBackend([a,b],anchor);
 try{
  const hits=await backend.search('Economic Policy Uncertainty Index USEPUINDXD March 2026',10,anchor);
  assert.deepEqual(hits.map(h=>h.url),[a.url]);assert.match(hits[0]!.snippet,/2026-02-12: 492.91/);
  assert.equal((await backend.search('T5YIFX nonexistentseries March 2026',10,anchor)).length,0);
  const text=(await backend.fetch(a.url,anchor))!.body;a.body='mutated';assert.equal((await backend.fetch(a.url,anchor))!.body,text);
  await assert.rejects(backend.search('USEPUINDXD',10,'2026-03-02T00:00:00Z'),/anchor/);
 }finally{backend.close();}
});
test('refuses altered bytes and captures at or after the boundary',()=>{
 const good=doc('USEPUINDXD','USEPUINDXD observation');
 assert.throws(()=>new ArchiveSupplementBackend([{...good,body:'changed'}],anchor),/matching text hash/);
 assert.throws(()=>new ArchiveSupplementBackend([{...good,title:'Later result'}],anchor),/matching text hash/);
 assert.throws(()=>new ArchiveSupplementBackend([doc('USEPUINDXD','observation',anchor)],anchor),/not before/);
});
test('newer query dates still expose the archived observation instead of repeated navigation',async()=>{
 const body='10-Year Breakeven Inflation Rate (T10YIE) | FRED | St. Louis Fed '+
  'Explore Our Apps FRED Tools and resources to find and use economic data worldwide. '.repeat(12)+
  '10-Year Breakeven Inflation Rate (T10YIE) Observations 2025-12-12: 2.26 | Percent, Not Seasonally Adjusted | Daily Updated: Dec 12, 2025 4:02 PM CST';
 const backend=new ArchiveSupplementBackend([doc('T10YIE',body,'2025-12-15T17:36:21Z')],anchor);
 try {
  const hit=(await backend.search('T10YIE February 2026',10,anchor))[0]!;
  assert.match(hit.snippet,/2025-12-12: 2.26/);
  assert.doesNotMatch(hit.snippet,/Explore Our Apps/);
  assert.ok(hit.snippet.length<=300);
  assert.equal(hit.crawlDate,'2025-12-15T17:36:21Z');
 } finally {backend.close();}
});

function namedDoc(id:string,title:string,body:string,date='2026-02-25T00:00:00Z'):VerifiedArchiveDocument {
 const d=doc(id,body,date);d.title=title;
 d.capture_proof.document_sha256=hash(JSON.stringify([d.url,d.title,d.body,d.crawlDate]));return d;
}

test('natural source lookup keeps dated history, maturity and numeric constraints, excluding related-series sidebars',async()=>{
 const body='Treasury source Observations 2026-02-20: 3.47 Percent Daily. Source: Federal Reserve. '+
  'Release Tables Related Data 20-year Treasury yields. China Treasury yields. '+
  'Tags Treasury 2-Year Nation United States of America Permalink/Embed';
 const d=namedDoc('DGS2','2-Year Treasury Yield (DGS2)',body);
 const model=namedDoc('EXPINF10YR','10-Year Expected Inflation (EXPINF10YR)','Source Observations Feb 2026: 2.3 Percent. Model estimates use Treasury yields and inflation data. Release Tables');
 const backend=new ArchiveSupplementBackend([d,model],anchor);
 try {
  const query='US 2-year Treasury yields March 2026 forecast';
  assert.equal(backend.hasPreferredSource(query),true);
  const hits=await backend.search(query,1,anchor);
  assert.equal(hits[0]?.url,d.url);assert.match(hits[0]!.snippet,/2026-02-20: 3.47/);
  assert.doesNotMatch(hits[0]!.snippet,/China|20-year/);assert.ok(hits[0]!.snippet.length<=300);
  assert.equal((await backend.fetch(d.url,anchor))!.body,body);
  assert.equal((await backend.search('national Treasury yields February 2026',1,anchor))[0]?.url,d.url);
  for(const bad of ['US 20-year Treasury yields February 2026','US 20–year Treasury yields February 2026','US 10-year Treasury yield February 2026','US 10-year Treasury rate February 2026','China Treasury yields February 2026','DGS20 yields February 2026','Treasury yields 3.4 February 2026'])
   assert.equal((await backend.search(bad,10,anchor)).length,0,bad);
 } finally {backend.close();}
});

test('natural source lookup matches only the version that fetch will serve',async()=>{
 const old=namedDoc('DGS2','2-Year Treasury Yield (DGS2)','Source Observations 2026-02-01: 3.4 cobalt yields Release Tables','2026-02-02T00:00:00Z');
 const current=namedDoc('DGS2','2-Year Treasury Yield (DGS2)','Source Observations 2026-02-20: 3.47 copper yields Release Tables');
 const backend=new ArchiveSupplementBackend([old,current],anchor);
 try {
  assert.equal((await backend.search('cobalt yields',10,anchor)).length,0);
  assert.equal((await backend.search('copper yields',10,anchor))[0]?.url,current.url);
  assert.equal((await backend.fetch(current.url,anchor))!.body,current.body);
 } finally {backend.close();}
});
