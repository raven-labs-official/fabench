/** Incremental source preparation. Revision bytes stay in the existing shared cache. */
import {readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, statfsSync, realpathSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {hostname, userInfo} from 'node:os';
import {WikipediaCache, wikiAnchor, WIKIPEDIA_CACHE_POLICY, WIKIPEDIA_RESOLUTION_POLICY,
  type WikiManifest, type WikiRevision, type WikiTarget, resolveWikiDocument} from './wikipedia-cache.js';
import {wikipediaTarget} from '../retrieval/document-reader.js';
import {sha256} from '../retrieval/evidence-store.js';

export const WIKI_EXPANSION_POLICY = 'wiki-additive-historical-links-v1';
type Member = WikiManifest['revisions'][number];
export type Seed = {url:string; reason:string; category:string; questionIds:string[]};
export type Seeds = {selection:string; seeds:Seed[]};
export type Origin = {kind:'explicit'; reason:string; category:string; questionIds:string[]} |
  {kind:'historical-link'; host:string; pageId:number; version:string; bodySha256:string; offset:number};
export type Candidate = {url:string; origins:Origin[]; cachedVersion:string|null; state:'base-member'|'cached-addition'|'needs-resolution'};
export type ExpansionPlan = {
  policy:typeof WIKI_EXPANSION_POLICY; anchor:string; selection:string;
  base:{file:string; sha256:string; documents:number}; cachePath:string; seedsSha256:string;
  rule:{links:'none'|'one-hop'; minParentPages:number; maxCandidates:number|null; ordering:string};
  batch?:{parentPlanSha256:string;start:number;end:number;totalCandidates:number};
  counts:{eligible:number; selected:number; omitted:number; baseMembers:number; cachedAdditions:number; needsResolution:number};
  storage:{cacheBytes:number; availableBytes:number; baseCompressedBytes:number; baseBodyBytes:number; roughAdditionalBytes:number};
  candidates:Candidate[];
};
export class ExpansionLimitError extends Error {}
const key=(r:{host:string;pageId:number})=>JSON.stringify([r.host,r.pageId]);
const ref=(d:WikiRevision):Member=>({host:d.host,pageId:d.pageId,version:d.version,bodySha256:d.bodySha256,availableAt:d.availableAt,cachedAt:d.cachedAt});
export function cacheBytes(path:string):number {
  return [path,path+'-wal',path+'-shm'].reduce((n,p)=>n+(existsSync(p)?statSync(p).size:0),0);
}
export function availableBytes(path:string):number {
  const s=statfsSync(path);return s.bavail*s.bsize;
}
function article(url:string):WikiTarget {
  const u=new URL(url),t=wikipediaTarget(url);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!t?.title||t.revision||u.search||u.hash||excludedTitle(t.title))
    throw new Error('Expansion seeds must be HTTPS Wikipedia article titles, without namespace, query, or fragment');
  return {host:t.host,title:t.title.normalize('NFC').replaceAll('_',' ').trim()};
}
function excludedTitle(title:string):boolean {
  const normalized=title.trim().replace(/^:/,'').replaceAll('_',' ');
  // Colons also occur in mainspace titles such as "Dune: Part Two".
  return /^(?:(?:file|image|category|template|help|wikipedia|wp|project|portal|draft|module|special|media|talk|user|book|timedtext)(?: talk)?|[a-z]{2,3}(?:-[a-z]+)?|commons|meta|wikidata|wikt|wiktionary|wikisource|wikiquote|wikinews|wikibooks|wikiversity|wikivoyage|simple|w|q|s):/i.test(normalized);
}
function articleUrl(t:WikiTarget):string{return `${t.host}/wiki/${encodeURIComponent(t.title!.replaceAll(' ','_'))}`;}
function integer(n:number,label:string,min:number,max:number){if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`Invalid ${label}`);}
export function parseSeeds(raw:string):Seeds {
  const d=JSON.parse(raw) as Seeds;
  if(!d||typeof d.selection!=='string'||!d.selection.trim()||!Array.isArray(d.seeds)||d.seeds.length>10000||Object.keys(d).some(k=>!['selection','seeds'].includes(k)))throw new Error('Expected selection and explicit seeds');
  for(const s of d.seeds){
    if(!s||Object.keys(s).some(k=>!['url','reason','category','questionIds'].includes(k))||typeof s.reason!=='string'||!s.reason.trim()||typeof s.category!=='string'||!s.category.trim()||!Array.isArray(s.questionIds)||s.questionIds.some(q=>typeof q!=='string'||!q.trim()))throw new Error('Every seed needs reason, category, and questionIds (may be empty)');
    article(s.url);
  }
  return d;
}
export function loadBase(file:string,cache:WikipediaCache):{raw:string;manifest:WikiManifest;compressedBytes:number;bodyBytes:number} {
  const raw=readFileSync(file,'utf8'),manifest=JSON.parse(raw) as WikiManifest;
  if(manifest?.policy!==WIKIPEDIA_CACHE_POLICY||!Array.isArray(manifest.revisions)||wikiAnchor(manifest.anchor)!==manifest.anchor)throw new Error('Invalid base Wiki manifest');
  const seen=new Set<string>();let compressedBytes=0,bodyBytes=0;
  for(const r of manifest.revisions){
    const d=cache.get(r.host,r.version);
    if(seen.has(key(r))||!d||d.redirectTarget||JSON.stringify(ref(d))!==JSON.stringify({host:r.host,pageId:r.pageId,version:r.version,bodySha256:r.bodySha256,availableAt:r.availableAt,cachedAt:r.cachedAt})||Date.parse(d.availableAt)>=Date.parse(manifest.anchor))throw new Error('Base manifest revision mismatch');
    seen.add(key(r));bodyBytes+=Buffer.byteLength(d.body);compressedBytes+=cache.revisionBytes(r.host,r.version);
  }
  return {raw,manifest,compressedBytes,bodyBytes};
}
/** Literal prose links in old wikitext. References/templates are not topic evidence.
 * Mask excluded spans without shifting the UTF-16 provenance offsets. */
export function historicalLinks(body:string):{title:string;offset:number}[] {
  const literals=body.replace(/<!--[\s\S]*?(?:-->|$)|<(nowiki|pre|source|syntaxhighlight|ref)\b[^>]*\/>|<(nowiki|pre|source|syntaxhighlight|ref)\b[^>]*>[\s\S]*?(?:<\/\2\s*>|$)/gi,s=>' '.repeat(s.length));
  const chunks:string[]=[];let depth=0,start=0,last=0;
  for(let i=0;i<literals.length-1;i++){
    if(literals[i]==='{'&&literals[i+1]==='{'){
      if(depth===0){start=i;chunks.push(literals.slice(last,i));}depth++;i++;
    }else if(depth>0&&literals[i]==='}'&&literals[i+1]==='}'){
      depth--;i++;if(depth===0){last=i+1;chunks.push(' '.repeat(last-start));}
    }
  }
  chunks.push(depth>0?' '.repeat(literals.length-start):literals.slice(last));
  const masked=chunks.join('');
  const found=new Map<string,number>();
  for(const m of masked.matchAll(/\[\[([^\[\]\n|]+)(?:\|[^\]\n]*)?\]\]/g)){
    const title=m[1]!.split('#')[0]!.trim().replaceAll('_',' ').normalize('NFC');
    if(!title||title.length>255||/[{}<>\u0000-\u001f]/.test(title)||excludedTitle(title))continue;
    if(!found.has(title))found.set(title,m.index!);
  }
  return [...found].map(([title,offset])=>({title,offset}));
}
export function planExpansion(options:{cachePath:string;baseFile:string;seedsRaw:string;links:'none'|'one-hop';minParentPages:number;maxCandidates:number|null}):ExpansionPlan {
  integer(options.minParentPages,'minParentPages',1,100000);
  if(options.maxCandidates!==null)integer(options.maxCandidates,'maxCandidates',1,500000);
  if(!['none','one-hop'].includes(options.links))throw new Error('Invalid link rule');
  const seeds=parseSeeds(options.seedsRaw),cache=new WikipediaCache(options.cachePath,true);
  try{
    const base=loadBase(options.baseFile,cache), members=new Set(base.manifest.revisions.map(key));
    const byUrl=new Map<string,Origin[]>();
    const add=(url:string,origin:Origin)=>{const list=byUrl.get(url)??[];list.push(origin);byUrl.set(url,list);};
    for(const s of seeds.seeds)add(articleUrl(article(s.url)),{kind:'explicit',reason:s.reason,category:s.category,questionIds:s.questionIds});
    if(options.links==='one-hop')for(const r of base.manifest.revisions){
      const d=cache.get(r.host,r.version)!;
      for(const link of historicalLinks(d.body))add(articleUrl({host:r.host,title:link.title}),{kind:'historical-link',host:r.host,pageId:r.pageId,version:r.version,bodySha256:r.bodySha256,offset:link.offset});
    }
    const support=(origins:Origin[])=>origins.filter(o=>o.kind==='historical-link').length;
    const explicit=(origins:Origin[])=>origins.some(o=>o.kind==='explicit');
    const eligible=[...byUrl].filter(([,o])=>explicit(o)||support(o)>=options.minParentPages)
      .sort(([a,ao],[b,bo])=>Number(explicit(bo))-Number(explicit(ao))||support(bo)-support(ao)||(a<b?-1:a>b?1:0));
    if(options.maxCandidates!==null&&eligible.filter(([,o])=>explicit(o)).length>options.maxCandidates)throw new Error('maxCandidates would omit explicit seeds');
    if(eligible.length>500000&&options.maxCandidates===null)throw new Error('Plan exceeds 500,000 candidates; select smaller source manifests or an explicit cap');
    const candidates=eligible.slice(0,options.maxCandidates??eligible.length).map(([url,origins]):Candidate=>{
      const d=cache.selected(article(url),base.manifest.anchor);
      return {url,origins,cachedVersion:d?.version??null,state:d?(members.has(key(d))?'base-member':'cached-addition'):'needs-resolution'};
    });
    const baseMembers=candidates.filter(c=>c.state==='base-member').length,cachedAdditions=candidates.filter(c=>c.state==='cached-addition').length;
    const needsResolution=candidates.length-baseMembers-cachedAdditions;
    return {policy:WIKI_EXPANSION_POLICY,anchor:base.manifest.anchor,selection:seeds.selection,
      base:{file:realpathSync(options.baseFile),sha256:sha256(base.raw),documents:base.manifest.revisions.length},cachePath:realpathSync(cache.path),seedsSha256:sha256(options.seedsRaw),
      rule:{links:options.links,minParentPages:options.minParentPages,maxCandidates:options.maxCandidates,ordering:'explicit-first, parent-page-count-descending, URL-codepoint-ascending'},
      counts:{eligible:eligible.length,selected:candidates.length,omitted:eligible.length-candidates.length,baseMembers,cachedAdditions,needsResolution},
      storage:{cacheBytes:cacheBytes(cache.path),availableBytes:availableBytes(dirname(cache.path)),baseCompressedBytes:base.compressedBytes,baseBodyBytes:base.bodyBytes,
        roughAdditionalBytes:Math.ceil(needsResolution*base.compressedBytes/Math.max(1,base.manifest.revisions.length))},candidates};
  }finally{cache.close();}
}
/** Execution batches retain their parent plan identity; the selection is not re-ranked. */
export function batchExpansionPlan(planRaw:string,start:number,count:number):string {
  const plan=JSON.parse(planRaw) as ExpansionPlan;
  if(plan.policy!==WIKI_EXPANSION_POLICY||!Array.isArray(plan.candidates)||plan.batch)throw new Error('Expected an unsliced expansion plan');
  integer(start,'batch start',0,Math.max(0,plan.candidates.length-1));integer(count,'batch count',1,500000);
  const end=Math.min(plan.candidates.length,start+count),candidates=plan.candidates.slice(start,end);
  return JSON.stringify({...plan,candidates,batch:{parentPlanSha256:sha256(planRaw),start,end,totalCandidates:plan.candidates.length}},null,2)+'\n';
}
export function mergeExpansion(base:WikiManifest,additions:(Member & {redirectTarget?:string})[]):WikiManifest {
  const byPage=new Map(base.revisions.map(r=>[key(r),r]));
  for(const d of additions){
    if(d.redirectTarget||Date.parse(d.availableAt)>=Date.parse(base.anchor))throw new Error('Invalid expansion revision');
    // Original members win, even when a new alias resolves to another pre-anchor revision.
    if(!byPage.has(key(d)))byPage.set(key(d),d);
  }
  return {...base,revisions:[...byPage.values()].sort((a,b)=>a.host.localeCompare(b.host)||a.pageId-b.pageId)};
}
export type StorageBudget = {minFreeBytes:number;maxGrowthBytes:number};
export function storageGuard(cachePath:string,outDir:string,budget:StorageBudget,initialBytes:number,
  measure:{size:(p:string)=>number;free:(p:string)=>number}={size:cacheBytes,free:availableBytes}) {
  integer(budget.minFreeBytes,'minFreeBytes',1,Number.MAX_SAFE_INTEGER);integer(budget.maxGrowthBytes,'maxGrowthBytes',1,Number.MAX_SAFE_INTEGER);
  return (compressedRevisionBytes=0)=>{
    // Reserve pages, B-tree overhead and WAL space for the next transaction. This is headroom,
    // not a claim about final compression; actual DB + WAL + SHM growth is checked each time.
    const headroom=4*(compressedRevisionBytes+65536);
    const growth=Math.max(0,measure.size(cachePath)-initialBytes);
    if(growth+headroom>budget.maxGrowthBytes)throw new ExpansionLimitError('Wiki cache growth budget exhausted');
    for(const p of [dirname(cachePath),outDir])if(measure.free(p)<budget.minFreeBytes+headroom)throw new ExpansionLimitError('Insufficient free space for Wiki expansion');
  };
}
export async function prepareExpansion(options:{planRaw:string;outDir:string;budget:StorageBudget;maxRequests:number;get:(url:string)=>Promise<string>;codeFingerprint:string}) {
  const plan=JSON.parse(options.planRaw) as ExpansionPlan;
  if(plan?.policy!==WIKI_EXPANSION_POLICY||!Array.isArray(plan.candidates)||plan.candidates.length>500000)throw new Error('Invalid expansion plan');
  integer(options.maxRequests,'maxRequests',0,100000);
  for(const c of plan.candidates){article(c.url);if(!Array.isArray(c.origins)||!c.origins.length)throw new Error('Candidate lacks selection provenance');}
  if(!plan.base||sha256(readFileSync(plan.base.file,'utf8'))!==plan.base.sha256)throw new Error('Base manifest changed since planning');
  const out=resolve(options.outDir);
  if(existsSync(out))throw new Error('Expansion output must be a new directory');
  const initialBytes=cacheBytes(plan.cachePath);
  const preflight=storageGuard(plan.cachePath,dirname(out),options.budget,initialBytes);preflight();
  const reader=new WikipediaCache(plan.cachePath,true);
  let base:ReturnType<typeof loadBase>;
  try{base=loadBase(plan.base.file,reader);}finally{reader.close();}
  if(base.manifest.anchor!==plan.anchor||base.manifest.revisions.length!==plan.base.documents)throw new Error('Plan anchor or base count mismatch');
  mkdirSync(out,{mode:0o2770});
  const save=(name:string,data:unknown)=>writeFileSync(join(out,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o660});
  writeFileSync(join(out,'plan.json'),options.planRaw,{flag:'wx',mode:0o660});
  const guard=storageGuard(plan.cachePath,out,options.budget,initialBytes);
  const receipt={policy:WIKI_EXPANSION_POLICY,planSha256:sha256(options.planRaw),resolutionPolicy:WIKIPEDIA_RESOLUTION_POLICY,
    owner:userInfo().username,host:hostname(),pid:process.pid,startedAt:new Date().toISOString(),codeFingerprint:options.codeFingerprint,
    cachePath:realpathSync(plan.cachePath),baseManifestSha256:plan.base.sha256,batch:plan.batch??null,budget:options.budget,maxRequests:options.maxRequests};
  save('started.json',receipt);
  const cache=new WikipediaCache(plan.cachePath,false,guard),additions:Member[]=[],rows:Record<string,unknown>[]=[];
  let requests=0,stopped:string|null=null;
  try{
    for(const c of plan.candidates){
      const began=Date.now();let row:Record<string,unknown>;
      try{
        guard();
        const before=requests;
        const {revision:d,redirects}=await resolveWikiDocument(article(c.url),plan.anchor,async url=>{
          guard();if(requests>=options.maxRequests)throw new ExpansionLimitError('Wiki API request budget exhausted');
          requests++;return options.get(url);
        },cache);
        additions.push(ref(d));
        const retained=base.manifest.revisions.find(r=>key(r)===key(d));
        row={url:c.url,ok:true,version:d.version,pageId:d.pageId,bodySha256:d.bodySha256,availableAt:d.availableAt,
          acquiredAt:d.acquiredAt,cachedAt:d.cachedAt,requests:requests-before,includedVersion:retained?.version??d.version,
          redirects:redirects.map(r=>({host:r.host,version:r.version,bodySha256:r.bodySha256,target:r.redirectTarget})),ms:Date.now()-began};
      }catch(error){
        row={url:c.url,ok:false,error:error instanceof Error?error.message:String(error),ms:Date.now()-began};
        if(error instanceof ExpansionLimitError)stopped=String(row.error);
      }
      rows.push(row);appendFileSync(join(out,'progress.jsonl'),JSON.stringify({...row,at:new Date().toISOString()})+'\n',{mode:0o660});
      if(stopped)break;
    }
    if(sha256(readFileSync(plan.base.file,'utf8'))!==plan.base.sha256)throw new Error('Base manifest changed during expansion');
    loadBase(plan.base.file,cache);
    const complete=rows.length===plan.candidates.length&&rows.every(r=>r.ok);
    let manifest: {file:string;sha256:string;documents:number;addedPages:number}|null=null;
    if(complete){
      guard();
      const merged=mergeExpansion(base.manifest,additions),file='wiki-expanded.json';
      const raw=JSON.stringify(merged,null,2)+'\n';
      writeFileSync(join(out,file),raw,{flag:'wx',mode:0o660});
      manifest={file,sha256:sha256(raw),documents:merged.revisions.length,addedPages:merged.revisions.length-base.manifest.revisions.length};
    }
    const result={...receipt,status:complete?'complete':'incomplete',finishedAt:new Date().toISOString(),requests,
      cacheBytesBefore:initialBytes,cacheBytesAfter:cacheBytes(plan.cachePath),basePreserved:true,stopped,manifest,rows,
      pending:plan.candidates.slice(rows.length).map(c=>c.url)};
    save('result.json',result);return result;
  }catch(error){
    save('failure.json',{...receipt,status:'failed',finishedAt:new Date().toISOString(),requests,error:error instanceof Error?error.message:String(error)});throw error;
  }finally{cache.close();}
}

/** Merge completed execution batches only after every parent-plan candidate is accounted for. */
export function mergeExpansionBatches(planRaw:string,resultFiles:string[],outFile:string) {
  const plan=JSON.parse(planRaw) as ExpansionPlan,parentHash=sha256(planRaw);
  if(plan?.policy!==WIKI_EXPANSION_POLICY||!Array.isArray(plan.candidates)||plan.batch)throw new Error('Expected an unsliced expansion plan');
  if(existsSync(outFile))throw new Error('Merged manifest output must be new');
  if(sha256(readFileSync(plan.base.file,'utf8'))!==plan.base.sha256)throw new Error('Base manifest changed');
  const cache=new WikipediaCache(plan.cachePath,true);
  try{
    const base=loadBase(plan.base.file,cache).manifest,covered=new Set<number>(),additions:{index:number;member:Member}[]=[];
    if(base.anchor!==plan.anchor)throw new Error('Parent plan anchor mismatch');
    for(const file of resultFiles){
      const result=JSON.parse(readFileSync(file,'utf8'));
      const batch=result.batch as ExpansionPlan['batch'];
      if(result.status!=='complete'||result.baseManifestSha256!==plan.base.sha256||!batch||batch.parentPlanSha256!==parentHash||batch.totalCandidates!==plan.candidates.length)throw new Error('Receipt is not a complete batch of this plan');
      integer(batch.start,'batch start',0,plan.candidates.length-1);integer(batch.end,'batch end',batch.start+1,plan.candidates.length);
      const expectedRaw=batchExpansionPlan(planRaw,batch.start,batch.end-batch.start);
      if(result.planSha256!==sha256(expectedRaw)||!Array.isArray(result.rows)||result.rows.length!==batch.end-batch.start)throw new Error('Batch plan or row count mismatch');
      for(let i=batch.start;i<batch.end;i++){
        const row=result.rows[i-batch.start];
        if(covered.has(i)||row.url!==plan.candidates[i]!.url||row.ok!==true)throw new Error('Batch overlap or incomplete candidate');
        covered.add(i);
        const t=article(row.url),selected=cache.selected(t,plan.anchor),d=cache.get(t.host,row.includedVersion);
        if(!selected||selected.version!==row.version||selected.pageId!==row.pageId||selected.bodySha256!==row.bodySha256)throw new Error('Batch row differs from cached URL selection');
        if(!d||d.redirectTarget||d.pageId!==row.pageId||Date.parse(d.availableAt)>=Date.parse(plan.anchor))throw new Error('Batch revision cannot be verified');
        if(row.includedVersion===row.version&&d.bodySha256!==row.bodySha256)throw new Error('Batch revision hash mismatch');
        const retained=base.revisions.find(r=>key(r)===key(d));
        if(row.includedVersion!==row.version&&(!retained||retained.version!==row.includedVersion))throw new Error('Only a base member may retain another version');
        additions.push({index:i,member:ref(d)});
      }
    }
    if(covered.size!==plan.candidates.length)throw new Error(`Incomplete batch coverage: ${covered.size}/${plan.candidates.length}`);
    const manifest=mergeExpansion(base,additions.sort((a,b)=>a.index-b.index).map(a=>a.member));
    if(sha256(readFileSync(plan.base.file,'utf8'))!==plan.base.sha256)throw new Error('Base manifest changed during merge');
    const raw=JSON.stringify(manifest,null,2)+'\n';writeFileSync(outFile,raw,{flag:'wx',mode:0o660});
    return {file:resolve(outFile),sha256:sha256(raw),parentPlanSha256:parentHash,documents:manifest.revisions.length,coveredCandidates:covered.size,batches:resultFiles.map(file=>resolve(file))};
  }finally{cache.close();}
}
