import {parseArgs} from 'node:util';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {planExpansion,prepareExpansion,batchExpansionPlan,mergeExpansionBatches} from '../src/corpus/wiki-expansion.js';
import {WikipediaCache,buildWikiIndex} from '../src/corpus/wikipedia-cache.js';
import {downloadJson} from '../src/retrieval/document-reader.js';
import {sha256} from '../src/retrieval/evidence-store.js';
import {SHARED_ROOT} from '../src/site-config.js';
import { projectEnv } from "../src/env-names.js";

const help=`Incremental Wikipedia preparation; existing cache and base manifest are required.
  plan --cache DB --base-manifest JSON [--seeds JSON] --out NEW_JSON
       [--links one-hop|none] [--min-parent-pages 1] [--max-candidates all|N]
  prepare --plan JSON --out NEW_DIRECTORY
       [--start 0 --count 500]
       [--min-free-gib 10] [--max-growth-mib 256] [--max-requests 1000]
  merge --plan JSON --receipts JSON_ARRAY_OF_RESULT_PATHS --out NEW_MANIFEST
  index --cache DB --manifest JSON --out NEW_INDEX [--min-free-gib 10] [--max-index-gib 4]

plan reads the cache without network calls. It writes metadata only; --out must not exist.
Planning includes all eligible one-hop prose links by default. Limits are explicit.
prepare appends missing revisions to the same cache and publishes a new manifest only
after every candidate succeeds. Retry the same plan into a new directory to reuse
completed work. It never switches a default manifest, copies a DB, or builds a CC index.
FABENCH_API_ADMISSION_DB must be set when preparing under the shared root (FABENCH_SHARED_ROOT).
Size estimates use existing compressed pages; they are not a guaranteed upper bound.
index builds a contentless disk FTS index referencing shared cache revisions.
Pass --wiki-index explicitly to retrieval workers using the expanded manifest.`;

async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{help:{type:'boolean'},cache:{type:'string'},'base-manifest':{type:'string'},seeds:{type:'string'},out:{type:'string'},plan:{type:'string'},
    links:{type:'string',default:'one-hop'},'min-parent-pages':{type:'string',default:'1'},'max-candidates':{type:'string',default:'all'},
    manifest:{type:'string'},'max-index-gib':{type:'string',default:'4'},start:{type:'string'},count:{type:'string'},receipts:{type:'string'},
    'min-free-gib':{type:'string',default:'10'},'max-growth-mib':{type:'string',default:'256'},'max-requests':{type:'string',default:'1000'}}});
  if(values.help){console.log(help);return;}
  if(positionals.length!==1||!values.out)throw new Error(help);
  if(positionals[0]==='plan'){
    if(!values.cache||!values['base-manifest']||!['none','one-hop'].includes(values.links))throw new Error(help);
    const seedsRaw=values.seeds?readFileSync(values.seeds,'utf8'):JSON.stringify({selection:'Literal prose links from the fixed pre-anchor Wikipedia manifest; no settlement or prediction-score inputs.',seeds:[]});
    const plan=planExpansion({cachePath:values.cache,baseFile:values['base-manifest'],seedsRaw,links:values.links as 'none'|'one-hop',minParentPages:Number(values['min-parent-pages']),maxCandidates:values['max-candidates']==='all'?null:Number(values['max-candidates'])});
    writeFileSync(values.out,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o660});
    console.log(JSON.stringify({plan:resolve(values.out),counts:plan.counts,storage:plan.storage},null,2));
  }else if(positionals[0]==='prepare'){
    if(!values.plan)throw new Error(help);
    if((values.start===undefined)!==(values.count===undefined))throw new Error('Use --start and --count together');
    const fullRaw=readFileSync(values.plan,'utf8');
    const planRaw=values.start===undefined?fullRaw:batchExpansionPlan(fullRaw,Number(values.start),Number(values.count));
    const plan=JSON.parse(planRaw);
    if(typeof plan.cachePath==='string'&&resolve(plan.cachePath).startsWith(SHARED_ROOT+'/')&&!projectEnv("FABENCH_API_ADMISSION_DB"))throw new Error('Set the shared FABENCH_API_ADMISSION_DB before preparing on the shared server');
    const sourceFiles=['expand-wikipedia.ts','../src/corpus/wiki-expansion.ts','../src/corpus/wikipedia-cache.ts','../src/retrieval/document-reader.ts','../src/llm/shared-rate-limit.ts'];
    const codeFingerprint=sha256(sourceFiles.map(p=>sha256(readFileSync(fileURLToPath(new URL(p,import.meta.url)),'utf8'))).join('\n'));
    const result=await prepareExpansion({planRaw,outDir:values.out,budget:{minFreeBytes:Number(values['min-free-gib'])*1024**3,maxGrowthBytes:Number(values['max-growth-mib'])*1024**2},maxRequests:Number(values['max-requests']),get:downloadJson,codeFingerprint});
    console.log(JSON.stringify({status:result.status,requests:result.requests,manifest:result.manifest,stopped:result.stopped},null,2));
    if(result.status!=='complete')process.exitCode=1;
  }else if(positionals[0]==='merge'){
    if(!values.plan||!values.receipts)throw new Error(help);
    const receipts=JSON.parse(readFileSync(values.receipts,'utf8'));
    if(!Array.isArray(receipts)||receipts.some(p=>typeof p!=='string'))throw new Error('receipts must contain a JSON array of result.json paths');
    console.log(JSON.stringify(mergeExpansionBatches(readFileSync(values.plan,'utf8'),receipts,values.out),null,2));
  }else if(positionals[0]==='index'){
    if(!values.cache||!values.manifest)throw new Error(help);
    const cache=new WikipediaCache(values.cache,true);
    try{console.log(JSON.stringify(buildWikiIndex(cache,JSON.parse(readFileSync(values.manifest,'utf8')),values.out,{minFreeBytes:Number(values['min-free-gib'])*1024**3,maxBytes:Number(values['max-index-gib'])*1024**3}),null,2));}finally{cache.close();}
  }else throw new Error(help);
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
