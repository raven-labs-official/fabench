/** Explicit source preparation; never discovers pages from settled answers. */
import {parseArgs} from 'node:util';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {WikipediaCache,wikiAnchor,resolveWikiDocument,WIKIPEDIA_RESOLUTION_POLICY} from '../src/corpus/wikipedia-cache.js';
import {downloadJson,wikipediaTarget} from '../src/retrieval/document-reader.js';
import {sha256} from '../src/retrieval/evidence-store.js';
const {values}=parseArgs({options:{plan:{type:'string'},cache:{type:'string'},out:{type:'string'},concurrency:{type:'string',default:'2'}}});
if(!values.plan||!values.cache||!values.out)throw new Error('Use --plan JSON --cache DB --out NEW_DIRECTORY [--concurrency 2]');
const concurrency=Number(values.concurrency);
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('Wiki preparation concurrency must be 1–4');
const raw=readFileSync(values.plan,'utf8');const plan=JSON.parse(raw) as {selection:string;urls:string[];anchors:string[]};
if(!plan.selection?.trim()||!Array.isArray(plan.urls)||!plan.urls.length||plan.urls.length>10000||!Array.isArray(plan.anchors)||!plan.anchors.length||plan.anchors.length>50)throw new Error('Expected selection rationale, 1–10000 URLs and 1–50 anchors');
const tasks=[...new Set(plan.anchors.map(wikiAnchor))].flatMap(anchor=>[...new Set(plan.urls)].map(url=>{const target=wikipediaTarget(url);if(!target)throw new Error('Non-Wiki URL');return {url,target,anchor};}));
mkdirSync(values.out,{mode:0o2770}); // A new receipt directory; never overwrite a prior preparation.
writeFileSync(join(values.out,'plan.json'),raw);
const cache=new WikipediaCache(values.cache),rows:unknown[]=[];let cursor=0,requests=0;
try{
  await Promise.all(Array.from({length:concurrency},async()=>{while(cursor<tasks.length){const task=tasks[cursor++]!,began=Date.now();
    try{const {revision,redirects}=await resolveWikiDocument(task.target,task.anchor,async url=>{requests++;return downloadJson(url);},cache);
      rows.push({url:task.url,anchor:task.anchor,ok:true,version:revision.version,pageId:revision.pageId,availableAt:revision.availableAt,acquiredAt:revision.acquiredAt,cachedAt:revision.cachedAt,bodySha256:revision.bodySha256,redirects:redirects.map(d=>({version:d.version,availableAt:d.availableAt,target:d.redirectTarget,bodySha256:d.bodySha256})),ms:Date.now()-began});
    }catch(error){rows.push({url:task.url,anchor:task.anchor,ok:false,error:error instanceof Error?error.message:String(error),ms:Date.now()-began});process.exitCode=1;}
    writeFileSync(join(values.out!,'progress.json'),JSON.stringify({requests,expected:tasks.length,rows},null,2)+'\n');
  }}));
  const manifests=[...new Set(tasks.map(t=>t.anchor))].map(anchor=>{const manifest=cache.manifest(anchor,tasks.filter(t=>t.anchor===anchor).map(t=>t.target)),file='wiki-'+anchor.replaceAll(':','-')+'.json';
    writeFileSync(join(values.out!,file),JSON.stringify(manifest,null,2)+'\n');return {file,sha256:sha256(JSON.stringify(manifest)),documents:manifest.revisions.length};});
  writeFileSync(join(values.out,'result.json'),JSON.stringify({planSha256:sha256(raw),resolutionPolicy:WIKIPEDIA_RESOLUTION_POLICY,finishedAt:new Date().toISOString(),requests,cachePath:cache.path,manifests,rows},null,2)+'\n');
}finally{cache.close();}
