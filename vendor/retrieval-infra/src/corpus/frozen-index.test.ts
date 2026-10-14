import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CorpusStore } from './store.js';
import { buildFrozenIndex } from './frozen-index.js';

const anchor='2026-03-01T00:00:00.000Z';
function seed(path:string,future=0) {
 const s=new CorpusStore(path,'or','write');
 s.ingest([{url:'https://test/a',title:'Alpha',body:'alpha alpha alpha beta',crawlDate:'2026-01-01T00:00:00Z'},
 {url:'https://test/b',title:'Beta',body:'beta beta beta alpha',crawlDate:'2026-02-01T00:00:00Z'},
 {url:'https://test/boundary',title:'Boundary',body:'alpha beta exact future result',crawlDate:anchor},
 ...Array.from({length:future},(_,i)=>({url:`https://test/future/${i}`,title:'Alpha',body:'alpha alpha alpha alpha',crawlDate:'2026-04-01T00:00:00Z'}))]);s.close();
}
test('full historical index excludes exact-anchor and later documents, including ranking statistics',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'frozen-index-'));
 try {
  const outputs=[];
  for(const n of [0,100]) {
   const src=join(dir,`source${n}.db`),index=join(dir,`index${n}.db`);seed(src,n);
   const meta=await buildFrozenIndex(src,index,anchor,{minimumFreeBytes:0});assert.equal(meta.documents,2);
   const s=new CorpusStore(index,'or');
   try {
    const hits=s.search('alpha beta',anchor,10);outputs.push(hits);
    assert.equal(hits.length,2);assert.equal(s.getByUrlBefore('https://test/b',anchor)?.body,'beta beta beta alpha');
    assert.equal(s.getByUrlBefore('https://test/boundary',anchor),null);
    assert.throws(()=>s.search('alpha', '2026-02-01T00:00:00Z'),/exact capture anchor/);
   } finally{s.close();}
  }
  assert.deepEqual(outputs[0],outputs[1]);
 } finally{rmSync(dir,{recursive:true,force:true});}
});
test('incomplete builds cannot serve and resume without duplicate documents',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'frozen-index-'));
 try {
  const src=join(dir,'source.db'),index=join(dir,'index.db');seed(src);
  const first=await buildFrozenIndex(src,index,anchor,{batchSize:1,maxBatches:1,minimumFreeBytes:0});assert.equal(first.status,'building');
  assert.throws(()=>new CorpusStore(index),/incomplete/);
  const last=await buildFrozenIndex(src,index,anchor,{batchSize:1,minimumFreeBytes:0});assert.equal(last.status,'complete');assert.equal(last.documents,2);
 } finally{rmSync(dir,{recursive:true,force:true});}
});
test('a changed source or invalid disk reserve cannot silently alter frozen content',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'frozen-index-'));
 try {
  const src=join(dir,'source.db'),index=join(dir,'index.db');seed(src);
  await assert.rejects(buildFrozenIndex(src,index,anchor,{minimumFreeBytes:Number.MAX_SAFE_INTEGER}),/disk reserve/);
  await buildFrozenIndex(src,index,anchor,{minimumFreeBytes:0});
  const reader=new CorpusStore(index,'or'),mutator=new DatabaseSync(src);
  mutator.prepare('UPDATE docs SET body=? WHERE id=1').run('a subsequently changed future outcome');mutator.close();
  assert.throws(()=>reader.getByUrlBefore('https://test/a',anchor),/differs from captured bytes/);reader.close();
  const reopened=new CorpusStore(index,'or');
  try { assert.throws(()=>reopened.getByUrlBefore('https://test/a',anchor),/differs from captured bytes/); } finally { reopened.close(); }
 } finally{rmSync(dir,{recursive:true,force:true});}
});

test('builder never repurposes an existing ordinary corpus as an output index',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'frozen-index-'));
 try {
  const src=join(dir,'source.db'),other=join(dir,'other.db');seed(src);seed(other);
  await assert.rejects(buildFrozenIndex(src,other,anchor,{minimumFreeBytes:0}),/not a resumable/);
  const db=new DatabaseSync(other,{readOnly:true});
  assert.equal((db.prepare('SELECT count(*) AS n FROM docs').get() as {n:number}).n,3);db.close();
 } finally{rmSync(dir,{recursive:true,force:true});}
});

test('frequency reuse stays inside an exact immutable anchor and mutable corpora stay fresh',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'frozen-frequency-'));
 try {
  const src=join(dir,'source.db'),index=join(dir,'index.db');seed(src);
  await buildFrozenIndex(src,index,anchor,{minimumFreeBytes:0});
  const reader=new CorpusStore(index,'concept');
  try {
   assert.equal(reader.termFrequency('alpha',anchor),2);
   assert.equal(reader.termFrequency('unrecorded',anchor),0);
   for(let i=0;i<4100;i++)reader.termFrequency(`absent${i}`,anchor);
   assert.equal(reader.termFrequency('alpha',anchor),2);
   assert.throws(()=>reader.termFrequency('alpha','2026-04-01T00:00:00Z'),/exact capture anchor/);
   const before=reader.searchRaw('alpha',anchor,5);
   const writer=new DatabaseSync(src);writer.prepare('UPDATE docs SET body=? WHERE id=1').run('changed alpha');writer.close();
   assert.ok(before.length>0);
   assert.throws(()=>reader.searchRaw('alpha',anchor,5),/differs from captured bytes/);
  } finally {reader.close();}
  const live=new CorpusStore(':memory:','concept');
  try {
   assert.equal(live.termFrequency('newterm',anchor),0);
   live.ingest([{url:'https://test/new',title:'newterm',body:'newterm',crawlDate:'2026-02-01T00:00:00Z'}]);
   assert.equal(live.termFrequency('newterm',anchor),1);
  } finally {live.close();}
 } finally {rmSync(dir,{recursive:true,force:true});}
});
