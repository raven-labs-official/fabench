import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PairedReviewer,type ReviewService} from './paired-reviewer.js';
import {EvidenceStore,sha256} from './evidence-store.js';
import type {EvidenceDocument} from './document-reader.js';
import type {EvidenceReview} from './evidence-reviewer.js';

const doc={id:'candidate',url:'https://example.test/page',title:'Report',body:'Before cutoff',bodySha256:sha256('Before cutoff'),temporalBasis:'live-page'} as EvidenceDocument;
const result:EvidenceReview={status:'leaked',basis:'model-assessed-later-content',reason:'later event',receiptId:'primary',costUsd:2,modelCalls:1,searchCalls:0,readCalls:0,cacheHit:false};
const service=(effort:string,run:ReviewService['review']):ReviewService=>({searchDelivery:'fulltext',review:run,
  configuration:()=>({effort}) as any,semanticConfiguration:()=>({effort}) as any,
  snapshot:()=>({costUsd:effort==='high'?2:1,modelCalls:1,searchCalls:0,readCalls:0,queueWaitMs:0,peakActive:1,active:0,queued:0}),close(){}});

test('both policies start concurrently; primary alone controls delivery; duplicate candidates reuse one archived pair',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'paired-review-')),artifacts=new EvidenceStore(dir);
  let primaryCalls=0,shadowCalls=0,releasePrimary:()=>void=()=>{},releaseShadow:()=>void=()=>{};
  const readyPrimary=new Promise<void>(r=>{releasePrimary=r;}),readyShadow=new Promise<void>(r=>{releaseShadow=r;});
  const primary=service('high',async seen=>{assert.equal(seen,doc);primaryCalls++;await readyPrimary;return result;});
  const shadow=service('low',async seen=>{assert.equal(seen,doc);shadowCalls++;await readyShadow;return {...result,status:'supported',receiptId:'shadow',admittedDocumentId:'shadow-only',costUsd:1};});
  try {
    const paired=new PairedReviewer(primary,shadow,artifacts);
    const first=paired.review(doc,'2026-07-01T00:00:00Z'),duplicate=paired.review(doc,'2026-07-01T00:00:00Z');
    await Promise.resolve();assert.equal(primaryCalls,1);assert.equal(shadowCalls,1);
    releaseShadow();releasePrimary();
    assert.deepEqual(await first,result);assert.equal((await duplicate).cacheHit,true);
    assert.equal((await paired.review(doc,'2026-07-01T00:00:00Z')).costUsd,0);
    assert.equal(primaryCalls,1);assert.equal(shadowCalls,1);
    const lines=readFileSync(join(dir,'paired-review/index.jsonl'),'utf8').trim().split('\n');assert.equal(lines.length,1);
    const receipt=artifacts.get<any>(JSON.parse(lines[0]!).artifactId);
    assert.equal(receipt.primary.result.status,'leaked');assert.equal(receipt.shadow.result.admittedDocumentId,'shadow-only');
    assert.equal(paired.snapshot().costUsd,2);assert.equal(paired.snapshot().shadow.costUsd,1);
    assert.equal(paired.configuration().shadow_review.delivery,'primary-only');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('shadow errors remain diagnostic; primary errors propagate after both outcomes are archived',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'paired-review-errors-')),artifacts=new EvidenceStore(dir);
  const good=service('high',async()=>result),bad=service('low',async()=>{throw new Error('provider failed; receipt archived');});
  try {
    const pair=new PairedReviewer(good,bad,artifacts);
    assert.deepEqual(await pair.review(doc,'2026-07-01T00:00:00Z'),result);
    assert.equal(pair.snapshot().paired.shadowErrors,1);
    const reverse=new PairedReviewer(bad,good,artifacts);
    await assert.rejects(reverse.review(doc,'2026-07-01T00:00:00Z'),/provider failed/);
    const records=readFileSync(join(dir,'paired-review/index.jsonl'),'utf8').trim().split('\n').map(x=>artifacts.get<any>(JSON.parse(x).artifactId));
    assert.equal(records[0].shadow.state,'error');assert.equal(records[1].primary.state,'error');assert.equal(records[1].shadow.state,'completed');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
