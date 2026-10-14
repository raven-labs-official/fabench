import test from 'node:test';
import assert from 'node:assert/strict';
import {splitReaderBlocks} from './reader-cleaner.js';
import {selectSinglePassText} from './single-pass-content.js';
import {SourceManifest} from './source-manifest.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {EvidenceDocument} from './document-reader.js';

test('selection keeps exact article bytes and rejects invalid or protected deletion spans',()=>{
  const article='Report\n\nRevenue is 42.\n\n| Metric | Value |\n| --- | --- |\n| Margin | 12% |\n\nRecommended stories\n\nLater event\n';
  const blocks=splitReaderBlocks(article);
  const answer=(from:string,to:string)=>JSON.stringify({status:'supported',reason:'Article precedes cutoff',remove:[{from,to,role:'recommendation',reason:'Separate recommendations'}]});
  const selected=selectSinglePassText(answer('b0003','b0004'),blocks);
  assert.equal(selected.body,article.slice(0,article.indexOf('Recommended')));
  assert.throws(()=>selectSinglePassText(answer('b0002','b0004'),blocks),/protected/);
  assert.throws(()=>selectSinglePassText(answer('b9999','b9999'),blocks),/Invalid/);
  assert.throws(()=>selectSinglePassText(answer('b0004','b0003'),blocks),/Invalid/);
  const singleton=selectSinglePassText(JSON.stringify({status:'supported',reason:'Old article',remove:[{from:'b0004',role:'recommendation',reason:'Separate recommendation'}]}),blocks);
  assert.deepEqual(singleton.removed,['b0004']);
  assert.equal(singleton.body,blocks.slice(0,4).map(b=>b.text).join(''));
  assert.throws(()=>selectSinglePassText(JSON.stringify({status:'supported',reason:'Old article',remove:[{from:'b0004',to:'b9999',role:'recommendation',reason:'Invalid end'}]}),blocks),/Invalid/);
  assert.throws(()=>selectSinglePassText('{"status":"supported"}',blocks),/Expected/);
});

test('single JSON framing and unordered disjoint ranges preserve exact positions; ambiguity and overlaps fail',()=>{
  const blocks=splitReaderBlocks('Article.\n\nNavigation.\n\nArticle continued.\n\nRecommendation.\n');
  const value={status:'supported',reason:'Old article',remove:[{from:blocks[3]!.id,role:'recommendation',reason:'Separate recommendation'},
    {from:blocks[1]!.id,role:'navigation',reason:'Separate navigation'}]};
  const text=JSON.stringify(value);
  assert.equal(selectSinglePassText('Assessment follows.\n```json\n'+text+'\n```',blocks).body,blocks[0]!.text+blocks[2]!.text);
  assert.equal(selectSinglePassText('```json '+text+'```',blocks).body,blocks[0]!.text+blocks[2]!.text);
  assert.throws(()=>selectSinglePassText(text+'\n'+text,blocks));
  assert.throws(()=>selectSinglePassText(JSON.stringify({...value,remove:[...value.remove,value.remove[0]]}),blocks),/overlapping/);
  assert.throws(()=>selectSinglePassText('Partial '+text.slice(0,-1),blocks));
});

test('registered issue time applies only to an exact URL and body hash',()=>{
  const dir=mkdtempSync(join(tmpdir(),'registered-source-'));try{
    const path=join(dir,'sources.json'),entry={url:'https://issuer.example/report.pdf',title:'Quarterly report',bodySha256:'a'.repeat(64),availableAt:'2026-01-28T23:59:59.999Z',version:'2026-Q1',sourceType:'financial-report',referenceUrl:'https://issuer.example/releases/q1',timeEvidence:'Issued January 28, 2026'};
    writeFileSync(path,JSON.stringify({policy:'registered-source-publication-v1',entries:[entry]}));
    const source=new SourceManifest(path),doc={url:entry.url,title:entry.title,bodySha256:entry.bodySha256} as EvidenceDocument;
    assert.equal(source.match(doc)?.version,'2026-Q1');
    assert.equal(source.match({...doc,bodySha256:'b'.repeat(64)}),undefined);
    assert.equal(source.match({...doc,url:'https://issuer.example/other.pdf'}),undefined);
    assert.equal(source.match({...doc,title:'Later revision'}),undefined);
  }finally{rmSync(dir,{recursive:true});}
});

import {validateResearchReferences} from './bounded-research.js';
test('research references must identify visible sources and retain their evidence scope',()=>{
  const visible=new Map([['search-result',{scope:'search-metadata'}],['read-passage',{scope:'source-passage'}]]);
  assert.deepEqual(validateResearchReferences(visible,['search-result','read-passage','read-passage']),[{sourceId:'search-result',scope:'search-metadata'},{sourceId:'read-passage',scope:'source-passage'}]);
  assert.throws(()=>validateResearchReferences(visible,['invented-source']),/actually returned/);
  assert.throws(()=>validateResearchReferences(visible,'read-passage'),/actually returned/);
  assert.deepEqual(validateResearchReferences(visible,undefined),[]);
});

import {reviewSinglePass} from './single-pass-content.js';
import {EvidenceStore} from './evidence-store.js';
import {DocumentReader} from './document-reader.js';
import type {LlmClient, LlmRequest} from '../llm/client.js';
import type {SearchProvider} from './search-providers.js';
import {ProviderApiError} from '../llm/openai-compatible.js';
test('single-pass reviewer isolates a DeepSeek content rejection with request ID',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'single-pass-content-risk-'));
  try{
    const artifacts=new EvidenceStore(dir);
    const provider:SearchProvider={name:'synthetic',async search(){return [];},stats:()=>({requests:0,failed:0})};
    const reader=new DocumentReader(async()=>[],artifacts);
    const client:LlmClient={id:'deepseek:synthetic',async complete(){throw new ProviderApiError('deepseek',400,'http_error',false,'invalid_request_error','Content Exists Risk (request_id: 52bec2cb-6ded-4736-ae62-d06f2588bc6f)');}};
    const doc:EvidenceDocument={id:'doc-1',url:'https://candidate.example/a',title:'Article',body:'Earlier article text.\n',bodySha256:'x'.repeat(64),acquiredAt:'2026-09-17T00:00:00Z',publishedDate:null,temporalBasis:'live-page',provenanceId:'p'};
    const review=await reviewSinglePass(client,artifacts,doc,'2026-03-01T00:00:00Z',180000,provider,reader);
    assert.equal(review.status,'unknown');
    assert.equal(review.failure?.kind,'provider-content-rejection');
    assert.equal(review.modelCalls,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a researched page review returns each earlier turn with its own reasoning to the same bound model',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'single-pass-replay-'));
  try{
    const artifacts=new EvidenceStore(dir);
    const provider:SearchProvider={name:'synthetic',async search(){return [{url:'https://source.example/a',title:'Release',snippet:'Published February 2, 2026'}];},stats:()=>({requests:1,failed:0})};
    const reader=new DocumentReader(async()=>[],artifacts);
    const requests:LlmRequest[]=[];let bound=0;
    const base:LlmClient={id:'synthetic:reviewer',async complete(req){
      requests.push(structuredClone({...req,signal:undefined,onTrace:undefined}));
      if(requests.length===1)return {text:'',reasoning:'Plan: check the launch date.',toolCalls:[{id:'call-1',name:'search_evidence',args:{query:'launch date'}}],finishReason:'tool_calls',costUsd:0,inputTokens:1,outputTokens:1};
      return {text:JSON.stringify({status:'supported',reason:'Release predates cutoff',evidenceIds:['e1'],remove:[]}),reasoning:'Checked.',finishReason:'stop',costUsd:0,inputTokens:1,outputTokens:1};
    }};
    const client:LlmClient={...base,startConversation(){bound++;return base;}};
    const body='The product launched on February 2, 2026.\n';
    const doc:EvidenceDocument={id:'doc-1',url:'https://candidate.example/a',title:'Launch',body,bodySha256:'x'.repeat(64),acquiredAt:'2026-09-17T00:00:00Z',publishedDate:null,temporalBasis:'live-page',provenanceId:'p'};
    const review=await reviewSinglePass(client,artifacts,doc,'2026-03-01T00:00:00Z',180000,provider,reader);
    assert.equal(review.status,'supported');assert.equal(bound,1);assert.equal(requests.length,2);
    const assistant=requests[1]!.messages!.filter(m=>m.role==='assistant');
    assert.deepEqual(assistant.map(m=>m.reasoning),['Plan: check the launch date.']);
    assert.equal(assistant[0]!.toolCalls![0]!.id,'call-1');
    assert.equal(requests[1]!.messages!.at(-1)!.toolCallId,'call-1');
    assert.ok(requests[1]!.messages!.filter(m=>m.role!=='assistant').every(m=>m.reasoning===undefined));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
