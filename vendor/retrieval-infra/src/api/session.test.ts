import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRetrievalSession, exactAnchor } from './session.js';
import {createHash} from 'node:crypto';
import {WikipediaCache,buildWikiIndex,wikiEndpoint} from '../corpus/wikipedia-cache.js';
import { CorpusStore } from '../corpus/store.js';
import { buildFrozenIndex } from '../corpus/frozen-index.js';

const asOf='2026-03-01T00:00:00.000Z';
test('public session and executable preserve the historical boundary and return parseable admitted data',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'infra-session-'));
 try {
  const source=join(dir,'source.db'),index=join(dir,'index.db');
  const s=new CorpusStore(source,'rarity','write');
  s.ingest([{url:'https://example.test/old',title:'Alpha outlook',body:'Alpha outlook historical evidence.',crawlDate:'2026-02-01'},
   {url:'https://example.test/future',title:'Alpha outcome',body:'Alpha future result.',crawlDate:'2026-04-01'}]);s.close();
  await buildFrozenIndex(source,index,asOf,{minimumFreeBytes:0});
  const session=createRetrievalSession({mode:'frozen',asOf,corpusPath:index,evidenceDirectory:join(dir,'evidence')});
  assert.equal(session.identity.profile,'quality-v1');
  assert.deepEqual((await session.search('alpha',10)).map(h=>h.url),['https://example.test/old']);
  assert.equal(await session.fetch('https://example.test/future'),null);
  await assert.rejects(session.search('alpha',21),/1 to 20/);
  session.close();await assert.rejects(session.search('alpha'),/closed/);
  const run=spawnSync(process.execPath,['bin/fabench-retrieval.mjs','search','--mode','frozen','--as-of',asOf,'--corpus',index,'--query','alpha','--evidence-dir',join(dir,'cli-evidence')],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);const response=JSON.parse(run.stdout);
  assert.equal(response.schema,'raven.retrieval-response.v1');assert.equal(response.results.length,1);
  assert.equal(response.identity.retrieval_entrypoint,'createRetrievalRuntime');
  for(const prefix of [['--','search'],['search','--']]) {
   const separated=spawnSync(process.execPath,['bin/fabench-retrieval.mjs',...prefix,'--mode','frozen','--as-of',asOf,'--corpus',index,'--query','alpha','--evidence-dir',join(dir,'cli-evidence')],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});
   assert.equal(separated.status,0,separated.stderr);assert.equal(JSON.parse(separated.stdout).results.length,1);
  }
  assert.ok(!run.stdout.includes('Alpha future result'));assert.ok(!('audit' in response));
  assert.throws(()=>createRetrievalSession({mode:'frozen',asOf,corpusPath:source}),/historical index/);
  assert.throws(()=>createRetrievalSession({mode:'frozen',asOf:'2026-04-01T00:00:00Z',corpusPath:index}),/exact anchor/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('public anchors require a timezone and equivalent instants normalize consistently',()=>{
 assert.throws(()=>exactAnchor('2026-03-01'),/timezone/);
 assert.throws(()=>exactAnchor('2026-03-01T00:00:00'),/timezone/);
 assert.equal(exactAnchor('2026-03-01T08:00:00+08:00'),asOf);
});


test('entity/time browsing reaches captures after the first page through the same public session and CLI', async () => {
 const dir=mkdtempSync(join(tmpdir(),'infra-browse-session-'));
 try {
  const source=join(dir,'source.db'),index=join(dir,'index.db'),body='Orion archival transcript. '+ 'Complete historic statement. '.repeat(30);
  const store=new CorpusStore(source,'rarity','write');
  store.ingest(Array.from({length:25},(_,i)=>({url:`https://example.test/orion/${i}`,title:`Orion ${i}`,body:i===0?body:'Orion brief news.',crawlDate:`2026-02-${String(i+1).padStart(2,'0')}T12:00:00Z`})));store.close();
  await buildFrozenIndex(source,index,asOf,{minimumFreeBytes:0});
  const session=createRetrievalSession({mode:'frozen',asOf,corpusPath:index,evidenceDirectory:join(dir,'evidence')});
  const options={entity:'Orion',since:'2026-02-01',until:'2026-02-28',limit:20};
  const first=await session.browse(options);
  assert.equal(first.results.length,20);assert.ok(first.nextCursor);
  assert.ok(!first.results.some(r=>r.url.endsWith('/0')));
  session.close();
  const args=['bin/fabench-retrieval.mjs','browse','--mode','frozen','--as-of',asOf,'--corpus',index,'--entity','Orion','--since',options.since,'--until',options.until,'--cursor',first.nextCursor!,'--evidence-dir',join(dir,'cli-evidence')];
  const cli=spawnSync(process.execPath,args,{cwd:new URL('../..',import.meta.url),encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);
  const last=JSON.parse(cli.stdout);assert.equal(last.results.length,5);assert.equal(last.nextCursor,null);
  assert.equal(last.results.at(-1).body,body);assert.ok(last.results.at(-1).capturedId);
  assert.equal(last.identity.profile,'quality-v1');assert.equal(last.query.order,'capture-desc-id-desc');
  const legacy=createRetrievalSession({mode:'frozen',asOf,corpusPath:index,profile:'baseline'});
  await assert.rejects(legacy.browse({entity:'Orion'}),/current frozen/);legacy.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('disk Wiki index is used by the public session and worker pool',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'wiki-session-'));let session:ReturnType<typeof createRetrievalSession>|undefined;
 try{
  const source=join(dir,'source.db'),index=join(dir,'cc-index.db'),wikiCachePath=join(dir,'wiki.db'),wikiIndexFile=join(dir,'wiki-index.db'),wikiManifestFile=join(dir,'wiki.json');
  const store=new CorpusStore(source,'rarity','write');store.ingest([{url:'https://example.test/news',title:'Other news',body:'Other historical evidence.',crawlDate:'2026-02-01'}]);store.close();
  await buildFrozenIndex(source,index,asOf,{minimumFreeBytes:0});
  const cache=new WikipediaCache(wikiCachePath),target={host:'https://en.wikipedia.org',title:'Orion'},body="'''Orion''' telescope historical evidence.";
  const raw=JSON.stringify({query:{pages:[{pageid:1,revisions:[{revid:42,timestamp:'2026-02-01T00:00:00Z',sha1:createHash('sha1').update(body).digest('hex'),slots:{main:{contentmodel:'wikitext',content:body}}}]}]}});
  cache.importCapture(target,asOf,raw,'2026-09-01T00:00:00Z',wikiEndpoint(target,asOf));const manifest=cache.manifest(asOf);
  writeFileSync(wikiManifestFile,JSON.stringify(manifest));const receipt=buildWikiIndex(cache,manifest,wikiIndexFile,{minFreeBytes:0});cache.close();
  session=createRetrievalSession({mode:'frozen',asOf,corpusPath:index,wikiCachePath,wikiManifestFile,wikiIndexFile,evidenceDirectory:join(dir,'evidence'),frozenWorkers:1});
  assert.equal((session.identity.wiki_snapshot as any).index.sha256,receipt.sha256);
  const hits=await session.search('Orion',10);assert.ok(hits.some(h=>h.url==='https://en.wikipedia.org/w/index.php?oldid=42'));
  const doc=await session.fetch('https://en.wikipedia.org/w/index.php?oldid=42');assert.ok(JSON.stringify(doc).includes('telescope historical evidence'));
 }finally{session?.close();rmSync(dir,{recursive:true,force:true});}
});
