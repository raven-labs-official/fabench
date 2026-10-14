import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {WikipediaCache,WikiSnapshot,buildWikiIndex,wikiEndpoint} from './wikipedia-cache.js';
import {historicalLinks,planExpansion,prepareExpansion,parseSeeds,storageGuard,ExpansionLimitError,mergeExpansion,batchExpansionPlan,mergeExpansionBatches} from './wiki-expansion.js';

const anchor='2026-07-01T00:00:00.000Z',host='https://en.wikipedia.org',target=(title:string)=>({host,title});
const api=(id:number,title:string,body:string,time='2026-06-15T00:00:00Z')=>JSON.stringify({query:{pages:[{pageid:id,title:'Current display title must not discover pages',revisions:[{revid:id*10,timestamp:time,sha1:createHash('sha1').update(body).digest('hex'),slots:{main:{contentmodel:'wikitext',content:body}}}]}]}});
const budget={minFreeBytes:1,maxGrowthBytes:128*1024**2};
function fixture(t:{after:(f:()=>void)=>void}){
  const dir=mkdtempSync(join(tmpdir(),'wiki-expansion-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'wiki.sqlite'),baseFile=join(dir,'base.json'),cache=new WikipediaCache(path);
  for(const [id,title,body] of [[1,'Alpha',"'''Alpha''' policy [[Beta]] [[Gamma]] <!-- [[Future leak]] -->"],[2,'Delta',"'''Delta''' policy [[Beta]] [[File:Image.png]]"]] as const)
    cache.importCapture(target(title),anchor,api(id,title,body),'2026-09-01T00:00:00Z',wikiEndpoint(target(title),anchor));
  const base=cache.manifest(anchor,[target('Alpha'),target('Delta')]);cache.close();
  writeFileSync(baseFile,JSON.stringify(base,null,2)+'\n');
  const seedsRaw=JSON.stringify({selection:'Synthetic topic preparation',seeds:[{url:host+'/wiki/Beta',reason:'Mechanism background',category:'synthetic',questionIds:[]}]});
  const plan=()=>planExpansion({cachePath:path,baseFile,seedsRaw,links:'one-hop',minParentPages:2,maxCandidates:10});
  return {dir,path,baseFile,base,seedsRaw,plan};
}
function originalRows(path:string){
  const db=new DatabaseSync(path,{readOnly:true});try{return {
    revisions:db.prepare('SELECT * FROM wiki_revisions ORDER BY host,version').all(),
    selections:db.prepare('SELECT * FROM wiki_selections ORDER BY host,selector,anchor').all()};}finally{db.close();}
}
test('Planning is read-only, follows old literal links, and records exact provenance',t=>{
  const f=fixture(t),before=originalRows(f.path),bytes=readFileSync(f.path),p=f.plan();
  assert.equal(p.candidates.length,1);assert.equal(p.candidates[0]!.url,host+'/wiki/Beta');
  assert.equal(p.candidates[0]!.origins.filter(o=>o.kind==='historical-link').length,2);
  assert.ok(p.candidates[0]!.origins.some(o=>o.kind==='explicit'));
  assert.equal(p.counts.needsResolution,1);assert.deepEqual(originalRows(f.path),before);assert.deepEqual(readFileSync(f.path),bytes);
  assert.equal(p.storage.baseBodyBytes>0,true);assert.equal(p.storage.baseCompressedBytes>0,true);
});
test('Historical links exclude comments, namespaces, interwiki links and literal nowiki',()=>{
  const body='😀 [[Beta#History|label]] <!-- [[Excluded]] --> <nowiki>[[Not a link]]</nowiki> [[File:X]] [[Category:Y]] [[fr:Z]] [[Gamma]]';
  const links=historicalLinks(body);assert.deepEqual(links.map(l=>l.title),['Beta','Gamma']);
  assert.equal(body.slice(links[0]!.offset,links[0]!.offset+2),'[[');
  assert.deepEqual(historicalLinks('<!-- unfinished [[Hidden]]'),[]);
  const prose='{{Infobox|nested={{cite web|agency=[[Reuters]]}}|item=[[Hidden]]}} [[Visible]] <ref name="x">[[News publisher]]</ref> [[After]]';
  assert.deepEqual(historicalLinks(prose).map(l=>l.title),['Visible','After']);
  assert.equal(historicalLinks(prose)[0]!.offset,prose.indexOf('[[Visible]]'));
  assert.deepEqual(historicalLinks('<ref name="x"/> [[Kept]]').map(l=>l.title),['Kept']);
  assert.deepEqual(historicalLinks('{{unfinished [[Hidden]]'),[]);
  assert.deepEqual(historicalLinks('[[Dune: Part Two]] [[:Category:Films]] [[Talk:Film]] [[wikt:film]]').map(l=>l.title),['Dune: Part Two']);
});
test('Seed provenance is required and accidental answer-bearing fields are rejected',()=>{
  assert.throws(()=>parseSeeds(JSON.stringify({selection:'fixture',seeds:[{url:host+'/wiki/Beta'}]})),/Every seed/);
  assert.throws(()=>parseSeeds(JSON.stringify({selection:'fixture',answer:1,seeds:[]})),/Expected/);
  assert.throws(()=>parseSeeds(JSON.stringify({selection:'fixture',seeds:[{url:host+'/wiki/Category:Future',reason:'x',category:'x',questionIds:[]}]})),/article titles/);
});
test('Appending keeps every old row, base manifest and old BM25 result unchanged',async t=>{
  const f=fixture(t),before=originalRows(f.path),manifestBytes=readFileSync(f.baseFile);
  const reader=new WikipediaCache(f.path,true),oldSnapshot=new WikiSnapshot(reader,f.base);
  const resultBefore=oldSnapshot.searchRaw('policy',anchor,10);let calls=0;
  const result=await prepareExpansion({planRaw:JSON.stringify(f.plan()),outDir:join(f.dir,'run'),budget,maxRequests:5,codeFingerprint:'synthetic',get:async url=>{
    calls++;assert.equal(new URL(url).searchParams.get('titles'),'Beta');return api(3,'Beta',"'''Beta''' policy policy policy extra");
  }});
  assert.equal(result.status,'complete');assert.equal(result.manifest?.addedPages,1);assert.equal(calls,1);
  assert.deepEqual(readFileSync(f.baseFile),manifestBytes);
  const after=originalRows(f.path);assert.deepEqual(after.revisions.filter(r=>Number(r.page_id)<3),before.revisions);
  assert.deepEqual(after.selections.filter(r=>['title:Alpha','title:Delta'].includes(String(r.selector))),before.selections);
  assert.deepEqual(oldSnapshot.searchRaw('policy',anchor,10),resultBefore);
  const rebuilt=new WikiSnapshot(reader,f.base);assert.deepEqual(rebuilt.searchRaw('policy',anchor,10),resultBefore);
  const expanded=JSON.parse(readFileSync(join(f.dir,'run','wiki-expanded.json'),'utf8'));
  const newSnapshot=new WikiSnapshot(reader,expanded);assert.equal(newSnapshot.searchRaw('extra',anchor,10).length,1);
  assert.equal(oldSnapshot.searchRaw('extra',anchor,10).length,0);
  oldSnapshot.close();rebuilt.close();newSnapshot.close();reader.close();
});
test('Retrying the same plan reuses completed revisions and never overwrites output',async t=>{
  const f=fixture(t),planRaw=JSON.stringify(f.plan());
  const args={planRaw,budget,maxRequests:5,codeFingerprint:'fixture'};
  await prepareExpansion({...args,outDir:join(f.dir,'first'),get:async()=>api(3,'Beta',"'''Beta''' mechanism")});
  const before=originalRows(f.path);
  const result=await prepareExpansion({...args,outDir:join(f.dir,'second'),maxRequests:0,get:async()=>{throw new Error('Network must not run');}});
  assert.equal(result.status,'complete');assert.equal(result.requests,0);assert.deepEqual(originalRows(f.path),before);
  await assert.rejects(prepareExpansion({...args,outDir:join(f.dir,'first'),get:async()=>''}),/new directory/);
});
test('One failed seed prevents publication and can be retried with cached successes',async t=>{
  const f=fixture(t),p=f.plan();p.candidates.push({...p.candidates[0]!,url:host+'/wiki/Gamma'});
  const args={planRaw:JSON.stringify(p),budget,maxRequests:5,codeFingerprint:'fixture'};
  const first=await prepareExpansion({...args,outDir:join(f.dir,'first'),get:async url=>{
    if(new URL(url).searchParams.get('titles')==='Gamma')throw new Error('Transient failure');
    return api(3,'Beta',"'''Beta''' background");
  }});
  assert.equal(first.status,'incomplete');assert.equal(first.manifest,null);assert.ok(!existsSync(join(f.dir,'first','wiki-expanded.json')));
  const seen:string[]=[];
  const second=await prepareExpansion({...args,outDir:join(f.dir,'second'),get:async url=>{seen.push(new URL(url).searchParams.get('titles')!);return api(4,'Gamma',"'''Gamma''' background");}});
  assert.equal(second.status,'complete');assert.deepEqual(seen,['Gamma']);assert.equal(second.manifest?.addedPages,2);
});
test('Request and disk budgets stop cleanly without publishing a partial manifest',async t=>{
  const f=fixture(t),before=originalRows(f.path);
  const result=await prepareExpansion({planRaw:JSON.stringify(f.plan()),outDir:join(f.dir,'run'),budget,maxRequests:0,codeFingerprint:'fixture',get:async()=>{throw new Error('Must not call');}});
  assert.equal(result.status,'incomplete');assert.match(result.stopped!,/request budget/);assert.equal(result.manifest,null);
  assert.deepEqual(originalRows(f.path),before);
  const guard=storageGuard(f.path,f.dir,{minFreeBytes:1000,maxGrowthBytes:1024**2},0,{size:()=>0,free:()=>1000});
  assert.throws(()=>guard(100),ExpansionLimitError);
  const growth=storageGuard(f.path,f.dir,{minFreeBytes:1,maxGrowthBytes:1024**2},0,{size:()=>1024**2,free:()=>1e12});
  assert.throws(()=>growth(),/growth budget/);
});
test('Storage guard inside a write transaction rolls back both revision and selection',async t=>{
  const f=fixture(t),before=originalRows(f.path);
  const cache=new WikipediaCache(f.path,false,()=>{throw new ExpansionLimitError('full');});
  await assert.rejects(cache.resolve(target('Beta'),anchor,async()=>api(3,'Beta',"'''Beta''' new")),/full/);cache.close();
  assert.deepEqual(originalRows(f.path),before);
});
test('Redirects add only their final page and never replace an original member',async t=>{
  const f=fixture(t),p=f.plan();
  const result=await prepareExpansion({planRaw:JSON.stringify(p),outDir:join(f.dir,'run'),budget,maxRequests:3,codeFingerprint:'fixture',get:async url=>{
    assert.equal(new URL(url).searchParams.get('redirects'),null);return api(3,'Beta','#REDIRECT [[Alpha]]');
  }});
  assert.equal(result.status,'complete');assert.equal(result.manifest?.addedPages,0);assert.equal(result.requests,1);
  const merged=mergeExpansion(f.base,[{...f.base.revisions[0]!,version:'999',bodySha256:'different'}]);
  assert.deepEqual(merged.revisions,f.base.revisions);
});
test('Changed base manifests and future revisions are refused',async t=>{
  const f=fixture(t),planRaw=JSON.stringify(f.plan());
  const result=await prepareExpansion({planRaw,outDir:join(f.dir,'future'),budget,maxRequests:1,codeFingerprint:'fixture',get:async()=>api(3,'Beta',"'''Beta''' future",anchor)});
  assert.equal(result.status,'incomplete');assert.equal(result.manifest,null);
  writeFileSync(f.baseFile,readFileSync(f.baseFile,'utf8')+'\n');
  await assert.rejects(prepareExpansion({planRaw,outDir:join(f.dir,'changed'),budget,maxRequests:1,codeFingerprint:'fixture',get:async()=>''}),/changed since planning/);
  assert.ok(!existsSync(join(f.dir,'changed')));
});
test('CLI plans into a new file and refuses an existing output path',t=>{
  const f=fixture(t),seeds=join(f.dir,'seeds.json'),out=join(f.dir,'plan.json');writeFileSync(seeds,f.seedsRaw);
  const args=['--import','tsx',fileURLToPath(new URL('../../tools/expand-wikipedia.ts',import.meta.url)),
    'plan','--cache',f.path,'--base-manifest',f.baseFile,'--seeds',seeds,'--out',out];
  const first=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(first.status,0,first.stderr);
  assert.equal(JSON.parse(readFileSync(out,'utf8')).counts.selected,2);
  assert.equal(JSON.parse(readFileSync(out,'utf8')).rule.maxCandidates,null);
  const bytes=readFileSync(out),again=spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.notEqual(again.status,0);assert.deepEqual(readFileSync(out),bytes);
});
test('All-candidate planning includes long-tail links beyond one thousand',t=>{
  const f=fixture(t),cache=new WikipediaCache(f.path);
  const body="'''Many topics''' "+Array.from({length:1107},(_,i)=>`[[Topic ${i}]]`).join(' ');
  cache.importCapture(target('Many topics'),anchor,api(9,'Many topics',body),'2026-09-01T00:00:00Z',wikiEndpoint(target('Many topics'),anchor));
  const base=cache.manifest(anchor,[target('Many topics')]);cache.close();writeFileSync(f.baseFile,JSON.stringify(base));
  const plan=planExpansion({cachePath:f.path,baseFile:f.baseFile,seedsRaw:JSON.stringify({selection:'Synthetic long-tail coverage',seeds:[]}),links:'one-hop',minParentPages:1,maxCandidates:null});
  assert.equal(plan.candidates.length,1107);assert.equal(plan.counts.omitted,0);
});
test('Execution batches merge only with complete, disjoint coverage of one fixed plan',async t=>{
  const f=fixture(t),p=planExpansion({cachePath:f.path,baseFile:f.baseFile,seedsRaw:f.seedsRaw,links:'one-hop',minParentPages:1,maxCandidates:null});
  assert.equal(p.candidates.length,2);const raw=JSON.stringify(p),files:string[]=[];
  for(let start=0;start<2;start++){
    const outDir=join(f.dir,'batch-'+start),planRaw=batchExpansionPlan(raw,start,1);
    await prepareExpansion({planRaw,outDir,budget,maxRequests:1,codeFingerprint:'fixture',get:async url=>{
      const title=new URL(url).searchParams.get('titles')!;return api(title==='Beta'?3:4,title,`'''${title}''' background`);
    }});files.push(join(outDir,'result.json'));
  }
  assert.throws(()=>mergeExpansionBatches(raw,files.slice(0,1),join(f.dir,'missing.json')),/Incomplete batch coverage/);
  assert.throws(()=>mergeExpansionBatches(raw,[...files,files[0]!],join(f.dir,'duplicate.json')),/overlap/);
  const out=mergeExpansionBatches(raw,[...files].reverse(),join(f.dir,'merged.json'));
  assert.equal(out.coveredCandidates,2);assert.equal(out.documents,4);
  const manifest=JSON.parse(readFileSync(out.file,'utf8'));for(const r of f.base.revisions)assert.deepEqual(manifest.revisions.find((n:any)=>n.pageId===r.pageId),r);
  assert.throws(()=>mergeExpansionBatches(raw,files,out.file),/must be new/);
  const other=JSON.stringify({...p,selection:'Different selection'});
  assert.throws(()=>mergeExpansionBatches(other,files,join(f.dir,'other.json')),/of this plan/);
});

test('Disk Wiki FTS preserves scores and fetches while storing bodies only in shared cache',async t=>{
  const f=fixture(t),cache=new WikipediaCache(f.path,true),path=join(f.dir,'index.sqlite');t.after(()=>cache.close());
  const before=originalRows(f.path),memory=new WikiSnapshot(cache,f.base);
  const receipt=buildWikiIndex(cache,f.base,path,{minFreeBytes:0,maxBytes:128*1024**2});
  const disk=new WikiSnapshot(cache,f.base,path);
  assert.equal(receipt.documents,2);assert.equal(receipt.sha256,disk.identity.index?.sha256);
  assert.equal(memory.identity.sha256,disk.identity.sha256);
  for(const query of ['policy','Alpha','"policy" OR "Delta"','"Alpha policy"'])assert.deepEqual(disk.searchRaw(query,anchor,10),memory.searchRaw(query,anchor,10));
  assert.equal(disk.frequency('policy'),memory.frequency('policy'));
  const url=host+'/w/index.php?oldid=10';assert.deepEqual(disk.getByUrlBefore(url,anchor),memory.getByUrlBefore(url,anchor));
  assert.throws(()=>disk.searchRaw('policy','2026-03-01T00:00:00Z',10),/anchor mismatch/);
  assert.throws(()=>new WikiSnapshot(cache,{...f.base,revisions:f.base.revisions.slice(1)},path),/manifest mismatch/);
  assert.throws(()=>buildWikiIndex(cache,f.base,path,{minFreeBytes:0}),/EEXIST/);
  const db=new DatabaseSync(path,{readOnly:true});assert.equal(db.prepare('SELECT body FROM docs_fts LIMIT 1').get()?.body,null);
  assert.ok(!(db.prepare('PRAGMA table_info(docs)').all()).some(row=>row.name==='body'));db.close();
  await prepareExpansion({planRaw:JSON.stringify(f.plan()),outDir:join(f.dir,'expanded'),budget,maxRequests:5,codeFingerprint:'fixture',get:async()=>api(3,'Beta',"'''Beta''' policy newtopic")});
  assert.deepEqual(disk.searchRaw('policy',anchor,10),memory.searchRaw('policy',anchor,10));assert.equal(disk.searchRaw('newtopic',anchor,10).length,0);
  assert.deepEqual(originalRows(f.path).revisions.filter(r=>Number(r.page_id)<3),before.revisions);
  disk.close();memory.close();
});
test('Disk index fails closed on invalid members, corruption and disk limits',t=>{
  const f=fixture(t),cache=new WikipediaCache(f.path,true);t.after(()=>cache.close());
  const path=join(f.dir,'index.sqlite');
  assert.throws(()=>buildWikiIndex(cache,f.base,path,{minFreeBytes:0,maxBytes:1}),/disk budget/);assert.ok(!existsSync(path));
  assert.throws(()=>buildWikiIndex(cache,{...f.base,revisions:[...f.base.revisions,...f.base.revisions]},path,{minFreeBytes:0}),/Duplicate/);assert.ok(!existsSync(path));
  buildWikiIndex(cache,f.base,path,{minFreeBytes:0});
  const db=new DatabaseSync(path);db.exec("UPDATE docs SET bodySha256='changed' WHERE id=1");db.close();
  assert.throws(()=>new WikiSnapshot(cache,f.base,path),/member mismatch/);
});
