import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveSupplementBackend, type VerifiedArchiveDocument } from './archive-supplement.js';
import { FrozenWithArchiveBackend, openFrozenArchive } from './frozen-with-archive.js';
import { CorpusStore } from '../corpus/store.js';
import { buildFrozenIndex } from '../corpus/frozen-index.js';
import type { BackendDoc, BackendResult, SearchBackend } from './search-backend.js';

const anchor = '2026-03-01T00:00:00Z';
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
const url = 'https://fred.stlouisfed.org/series/T5YIFR';
function document(body='T5YIFR inflation expectation historical series fixture'): VerifiedArchiveDocument {
  const title='T5YIFR historical fixture', crawlDate='2026-02-13T00:00:00Z';
  return {url,title,body,crawlDate,source:'cc-main',capture_proof:{text_sha256:hash(body),
    document_sha256:hash(JSON.stringify([url,title,body,crawlDate])),warc_record_id:'fixture',cdx_digest:'fixture'}};
}
function base(results:BackendResult[],doc:BackendDoc|null=null):SearchBackend {
  return {name:'frozen',search:async(_q,n)=>results.slice(0,n),fetch:async()=>doc,stats:()=>({})};
}
const news:BackendResult={url:'https://example.test/news',title:'News inflation outlook',snippet:'Historical news',source:'frozen',crawlDate:'2026-02-20T00:00:00Z'};
function generalDocument(): VerifiedArchiveDocument {
  const url='https://example.test/archive',title='Historical news source',body='Historical news source fixture',crawlDate='2026-02-13T00:00:00Z';
  return {url,title,body,crawlDate,source:'cc-main',capture_proof:{text_sha256:hash(body),document_sha256:hash(JSON.stringify([url,title,body,crawlDate])),warc_record_id:'fixture',cdx_digest:'fixture'}};
}

test('combined source preserves news while exact series uses the same total result budget',async()=>{
  const generic=generalDocument();
  const archive=new ArchiveSupplementBackend([document(),generic],anchor);
  const backend=new FrozenWithArchiveBackend(base([news]),archive);
  try {
    assert.deepEqual((await backend.search('T5YIFR March 2026',1,anchor)).map(r=>r.url),[url]);
    assert.deepEqual((await backend.search('historical news',2,anchor)).map(r=>r.url),[news.url,generic.url]);
    assert.deepEqual((await backend.search('historical news',1,anchor)).map(r=>r.url),[news.url]);
    assert.match((await backend.fetch(url,anchor))!.body,/historical series fixture/);
    await assert.rejects(backend.search('T5YIFR',2,'2026-03-02T00:00:00Z'),/anchor/);
    await assert.rejects(backend.search('T5YIFR',0,anchor),/positive/);
  } finally {archive.close();}
});

test('duplicate source URLs choose the latest pre-anchor capture and reject a later base result',async()=>{
  const archive=new ArchiveSupplementBackend([document()],anchor);
  const newer={...news,url,title:'Newer verified series',snippet:'Newer prior observation'};
  const backend=new FrozenWithArchiveBackend(base([newer],{...newer,body:'Newer prior observation'}),archive);
  try {
    const hits=await backend.search('T5YIFR',5,anchor);
    assert.equal(hits.length,1);assert.equal(hits[0]!.title,newer.title);
    assert.equal((await backend.fetch(url,anchor))!.body,'Newer prior observation');
    const invalid=new FrozenWithArchiveBackend(base([{...news,crawlDate:anchor}]),archive);
    await assert.rejects(invalid.search('inflation',5,anchor),/strictly pre-anchor/);
  } finally {archive.close();}
});

test('a guarded natural-language source match receives the same bounded priority as an exact code',async()=>{
  const url='https://fred.stlouisfed.org/series/DGS2',title='2-Year Treasury Yield (DGS2)',
    body='Treasury observations source Observations 2026-02-12: 3.47 Percent Daily. Release Tables',crawlDate='2026-02-15T00:00:00Z';
  const d:VerifiedArchiveDocument={url,title,body,crawlDate,source:'cc-main',capture_proof:{text_sha256:hash(body),document_sha256:hash(JSON.stringify([url,title,body,crawlDate])),warc_record_id:'fixture',cdx_digest:'fixture'}};
  const archive=new ArchiveSupplementBackend([d],anchor),backend=new FrozenWithArchiveBackend(base([news]),archive);
  try {
    const hits=await backend.search('US 2-year Treasury yields March 2026 forecast',1,anchor);
    assert.deepEqual(hits.map(h=>h.url),[url]);
    assert.match(hits[0]!.snippet,/2026-02-12: 3.47/);
    assert.equal((await backend.fetch(url,anchor))!.body,body);
  } finally {archive.close();}
});

test('file identity and copied captures require a completed historical index and matching anchors',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'frozen-archive-'));
  try {
    const source=join(dir,'source.db'),index=join(dir,'history.db'),file=join(dir,'archive.jsonl');
    const store=new CorpusStore(source,'or','write');store.ingest([{url:news.url,title:news.title,body:news.snippet,crawlDate:news.crawlDate!}]);store.close();
    writeFileSync(file,JSON.stringify(document())+'\n');
    assert.throws(()=>openFrozenArchive(file,source,[anchor]),/completed historical/);
    await buildFrozenIndex(source,index,anchor,{minimumFreeBytes:0});
    assert.throws(()=>openFrozenArchive(file,index,['2026-03-01']),/exact historical/);
    assert.throws(()=>openFrozenArchive(file,index,[anchor,'2026-03-02T00:00:00Z']),/exact historical/);
    const first=openFrozenArchive(file,index,[anchor]);
    try {
      writeFileSync(file,JSON.stringify(document('Changed but separately verified historical fixture'))+'\n');
      assert.match((await first.backend.fetch(url,anchor))!.body,/T5YIFR inflation/);
      const second=openFrozenArchive(file,index,[anchor]);
      try {assert.notEqual(first.identity.file_sha256,second.identity.file_sha256);assert.notEqual(first.identity.verified_documents_identity,second.identity.verified_documents_identity);}
      finally {second.close();}
    } finally {first.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
