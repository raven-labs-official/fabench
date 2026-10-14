import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SourceManifest} from './source-manifest.js';
import {EvidenceStore,sha256} from './evidence-store.js';
import {DocumentReader} from './document-reader.js';
import {EvidenceReviewer} from './evidence-reviewer.js';

test('registered versions bypass fetch and reviewer queues, retain tables, and fail on corruption',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-versions-'));
 const file=(name:string,body:string)=>{writeFileSync(join(dir,name),body);return {path:name,sha256:sha256(body)};};
 const body='Report\n| Revenue | USD million |\n| 12 | 5 |\n\n[1] Restatement excludes tax.';
 const url='https://issuer.test/report.pdf',alias='https://cdn.test/verified.pdf';
 const entry={url,title:'Issuer Q1',bodySha256:sha256(body),availableAt:'2026-01-30T00:00:00Z',version:'initial',sourceType:'financial-report',referenceUrl:'https://issuer.test/releases',timeEvidence:'Dated release links this report',publisher:'Issuer',reportingPeriod:'FY2026 Q1',aliases:[alias],acquiredAt:'2026-09-15T00:00:00Z',cachedAt:'2026-09-15T00:00:00Z',checkedAt:'2026-09-15T01:00:00Z',checkedBy:'test evidence',bodyFile:file('body.txt',body),originalFile:file('original.pdf','%PDF original fixture'),publicationEvidence:file('evidence.json','{"issued":"January 28, 2026"}')};
 const revised=body+'\nCorrection: revenue updated.',second={...entry,version:'corrected',availableAt:'2026-03-02T00:00:00Z',supersedes:'initial',bodySha256:sha256(revised),bodyFile:file('corrected.txt',revised)};
 const manifestPath=join(dir,'manifest.json');writeFileSync(manifestPath,JSON.stringify({policy:'registered-source-publication-v2',entries:[entry,second]}));
 try{
   const manifest=new SourceManifest(manifestPath),artifacts=new EvidenceStore(join(dir,'evidence'));
   let network=0,models=0;const reader=new DocumentReader(async()=>{network++;return [];},artifacts,undefined,undefined,undefined,undefined,manifest);
   const client={id:'fixture',complete:async()=>{models++;throw new Error('unexpected model');}};
   const reviewer=new EvidenceReviewer(client,{name:'fixture',search:async()=>[]},reader,artifacts,{processing:'single-pass',sourceManifestFile:manifestPath,concurrency:1});
   // Saturate the model queue: the historical source must still return immediately.
   (reviewer as any).active=1;
   const doc=await reader.read(alias,'2026-03-01T00:00:00Z');assert.equal(doc?.body,body);
   const result=await reviewer.review(doc!,'2026-03-01T00:00:00Z');assert.equal(result.status,'supported');assert.equal(result.modelCalls,0);
   assert.equal(network,0);assert.equal(models,0);
   const other=new EvidenceStore(join(dir,'other-process'));
   assert.equal(manifest.read(alias,'2026-03-03T00:00:00Z',other)?.body,revised);
   assert.equal(manifest.read(url,entry.availableAt,other),null);
   assert.equal(manifest.match({...doc!,body:'changed',bodySha256:sha256('changed')}),undefined);
   writeFileSync(join(dir,'body.txt'),'corrupt');
   assert.throws(()=>manifest.read(url,'2026-03-01T00:00:00Z',other),/hash mismatch/);
   reviewer.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
