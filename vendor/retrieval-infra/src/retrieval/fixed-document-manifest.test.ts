import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EvidenceStore,sha256} from './evidence-store.js';
import {createRetrievalRuntime} from '../api/runtime.js';
import {FixedDocumentManifest} from './fixed-document-manifest.js';

test('two runtimes reuse pinned live content and one shared assessment across execution concurrency',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fixed-page-')),source=new EvidenceStore(join(dir,'source')),anchor='2026-03-01T00:00:00Z',url='https://example.test/article';
 const body='Dated article with a complete table.\n| measure | USD |\n| A | 5 |\nFootnote (1): original definition.';
 const provenanceId=source.put({source:'fixture',original:'Complete captured response'});
 const doc={url,title:'February report',body,bodySha256:sha256(body),acquiredAt:'2026-09-15T00:00:00Z',publishedDate:'2026-02-01',temporalBasis:'live-page',provenanceId};
 const documentId=source.put(doc),manifest=join(dir,'fixed.json');
 writeFileSync(manifest,JSON.stringify({policy:'fixed-document-input-v1',artifactDirectory:source.directory,entries:[{url,anchor,documentId}]}));
 let models=0,network=0;const provider={name:'fixture',search:async()=>{network++;return [];}};
 const client={id:'fixture:model',complete:async()=>{models++;await new Promise(r=>setTimeout(r,40));return {text:JSON.stringify({status:'supported',reason:'Dated historical article',remove:[]}),costUsd:0.04,inputTokens:100,outputTokens:10};}};
 const opts={provider,reviewerClient:client,fixedDocumentManifestFile:manifest,sharedCacheDirectory:join(dir,'shared')};
 const a=createRetrievalRuntime({...opts,evidenceDirectory:join(dir,'a'),reviewOptions:{concurrency:1,searchDelivery:'fulltext'}}),b=createRetrievalRuntime({...opts,evidenceDirectory:join(dir,'b'),reviewOptions:{concurrency:2,searchDelivery:'fulltext'}});
 try{
   const results=await Promise.all([a.createBackend('web-filter').fetch(url,anchor),b.createBackend('web-filter').fetch(url,anchor)]);
   assert.deepEqual(results.map(d=>d?.body),[body,body]);assert.equal(models,1);assert.equal(network,0);
   assert.equal(a.reviewer!.snapshot().costUsd+b.reviewer!.snapshot().costUsd,0.04);
   const fixed=new FixedDocumentManifest(manifest);assert.equal(fixed.read(url,'2026-02-01T00:00:00Z',source),null);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
