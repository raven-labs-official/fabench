import test from 'node:test';
import assert from 'node:assert/strict';
import { PageDater } from './page-dater.js';
import { readerAcquisitionIdentity } from './document-reader.js';
import { DocumentReader } from './document-reader.js';
import { EvidenceStore, sha256 } from './evidence-store.js';
import { EvidenceReviewer } from './evidence-reviewer.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatedPage } from './page-dater.js';
import type { LlmClient } from '../llm/client.js';
import type { SearchProvider } from './search-providers.js';

test('independent runs share one snapshot and one review; anchors, pools and reviewer modes stay separate',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'shared-page-test-'));
  const anchor='2026-07-01T00:00:00Z',url='https://synthetic.example/report';
  let acquisitions=0,calls=0;
  const fetchPages=async(urls:readonly string[]):Promise<DatedPage[]>=>{
    acquisitions++;
    const body=`Report published June 20, 2026. Capture ${acquisitions}.`;
    return urls.map(url=>({url,title:'Report',text:body,date:'2026-06-20',why:'',source:'direct',content_document:{policy:'article-blocks-tables-v1',extractor:'synthetic',body_sha256:sha256(body),usable:true,unusable_reason:null,complete:true,source_format:'html',blocks:[]}}));
  };
  const stores=[new EvidenceStore(join(directory,'a')),new EvidenceStore(join(directory,'b'))];
  const readers=stores.map(store=>new DocumentReader(fetchPages,store,undefined,undefined,undefined,undefined,undefined,undefined,join(directory,'pages')));
  const client:LlmClient={id:'synthetic:reviewer',async complete(){calls++;return {text:JSON.stringify({status:'supported',reason:'Article predates anchor',remove:[],evidenceIds:[],summaryFragmentIds:['f00001']}),costUsd:0.01,inputTokens:10,outputTokens:10};}};
  const provider:SearchProvider={name:'synthetic',async search(){throw new Error('No research needed');},stats:()=>({requests:0,failed:0})};
  const reviewers=readers.map((reader,i)=>new EvidenceReviewer(client,provider,reader,stores[i]!,{processing:'single-pass',searchDelivery:'summary',sharedCacheDirectory:join(directory,'reviews')}));
  const extra:DocumentReader[]=[];const extraReviewers:EvidenceReviewer[]=[];
  try{
    const docs=await Promise.all(readers.map(reader=>reader.read(url,anchor)));
    assert.equal(acquisitions,1);assert.deepEqual(docs[0],docs[1]);
    const results=await Promise.all(reviewers.map((reviewer,i)=>reviewer.review(docs[i]!,anchor,{question:`question ${i}`})));
    assert.equal(calls,1);assert.ok(results.every(r=>r.status==='supported'));assert.equal(results.reduce((s,r)=>s+r.costUsd,0),0.01);
    assert.equal(results.filter(r=>r.cacheHit).length,1);
    assert.equal(readers.reduce((s,r)=>s+r.snapshot().sharedPageHits,0),1);
    assert.deepEqual(stores[1]!.get(docs[0]!.provenanceId),stores[0]!.get(docs[0]!.provenanceId));
    await readers[1]!.read(url,'2026-07-02T00:00:00Z');assert.equal(acquisitions,2);
    const fresh=new DocumentReader(fetchPages,stores[1]!,undefined,undefined,undefined,undefined,undefined,undefined,join(directory,'next-epoch'));extra.push(fresh);
    assert.notEqual((await fresh.read(url,anchor))!.bodySha256,docs[0]!.bodySha256);assert.equal(acquisitions,3);
    const changed=new EvidenceReviewer({...client,id:'synthetic:different-reviewer'},provider,readers[1]!,stores[1]!,{processing:'single-pass',searchDelivery:'summary',sharedCacheDirectory:join(directory,'reviews')});extraReviewers.push(changed);
    await changed.review(docs[1]!,anchor);assert.equal(calls,2);
  }finally{[...reviewers,...extraReviewers].forEach(r=>r.close());[...readers,...extra].forEach(r=>r.close());rmSync(directory,{recursive:true,force:true});}
});

test('failed acquisition is retriable and extraction configurations do not share snapshots',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'shared-page-retry-')),store=new EvidenceStore(join(directory,'local'));
  let calls=0;
  const readers=[{browser:false},{browser:true}].map(config=>new DocumentReader(async()=>{calls++;return [];},store,undefined,undefined,config,undefined,undefined,undefined,join(directory,'pages')));
  try{
    for(const reader of readers)for(let i=0;i<2;i++)assert.equal(await reader.read('https://synthetic.example/empty','2026-07-01T00:00:00Z'),null);
    assert.equal(calls,4);assert.equal(readers[0]!.snapshot().sharedPageHits,0);
    assert.notDeepEqual(readers[0]!.configuration(),readers[1]!.configuration());
  }finally{readers.forEach(r=>r.close());rmSync(directory,{recursive:true,force:true});}
});

test('real page-dater configurations have the same reader identity across output directories', () => {
  const a = new PageDater(true, undefined, undefined, undefined, {policy:'article-blocks-tables-v1',rawDirectory:'/data/run-a/raw'});
  const b = new PageDater(true, undefined, undefined, undefined, {policy:'article-blocks-tables-v1',rawDirectory:'/data/run-b/raw'});
  const browser = new PageDater(true, undefined, undefined, undefined, {policy:'article-blocks-tables-v1',rawDirectory:'/data/run-a/raw',browser:true});
  try {
    assert.deepEqual(readerAcquisitionIdentity(a.configuration()), readerAcquisitionIdentity(b.configuration()));
    assert.notDeepEqual(readerAcquisitionIdentity(a.configuration()), readerAcquisitionIdentity(browser.configuration()));
    assert.equal((a.configuration().content as {rawDirectory:string}).rawDirectory, '/data/run-a/raw');
    assert.equal((readerAcquisitionIdentity(a.configuration()) as {timeout_ms:number}).timeout_ms, a.configuration().timeout_ms);
  } finally { a.close(); b.close(); browser.close(); }
});
