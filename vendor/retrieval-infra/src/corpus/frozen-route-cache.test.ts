import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { FrozenRouteCache, frozenCacheSlots } from './frozen-route-cache.js';
import { FrozenWorkerPool } from './frozen-worker-pool.js';
import { CorpusStore } from './store.js';
import { buildFrozenIndex } from './frozen-index.js';
import { RankFeatureCache, planQuery, rankAndDeduplicate } from './query-plan.js';

test('shared routes isolate identity/limit, cache empty hits, recover corruption and stay bounded',()=>{
  const dir=mkdtempSync(join(tmpdir(),'frozen-route-')),path=join(dir,'cache.sqlite');
  const limits={workers:4,maxBytes:256,maxEntries:2};
  const a=new FrozenRouteCache(path,'a',limits),b=new FrozenRouteCache(path,'b',limits);let calls=0;
  assert.equal(frozenCacheSlots(path),4);
  assert.equal(frozenCacheSlots(join(dir,'absent')),4);
  const compute=()=>{calls++;return [{rowid:1,rank:-1}];};
  try {
    assert.deepEqual(a.getOrCompute('query',1,compute),a.getOrCompute('query',1,compute));assert.equal(calls,1);
    b.getOrCompute('query',1,compute);assert.equal(calls,2);
    a.getOrCompute('query',2,compute);assert.equal(calls,3);
    a.getOrCompute('empty',1,()=>[]);a.getOrCompute('empty',1,()=>{throw new Error('must reuse empty');});
    const db=new DatabaseSync(path);
    try {
      assert.ok(Number(db.prepare('SELECT count(*) n FROM routes').get()!.n)<=2);
      db.prepare('UPDATE routes SET sha256=?').run('damaged');
      assert.deepEqual(a.getOrCompute('empty',1,()=>[{rowid:2,rank:-2}]),[{rowid:2,rank:-2}]);
    } finally {db.close();}
    assert.throws(()=>new FrozenRouteCache(path,'a',{...limits,workers:8}),/configuration differs/);
  } finally {a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('route reuse preserves candidate order and rechecks all captured bodies',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'frozen-route-source-')),source=join(dir,'source.db'),index=join(dir,'index.db');
  const anchor='2026-07-01T00:00:00.000Z';
  const writer=new CorpusStore(source,'concept','write');
  writer.ingest(Array.from({length:12},(_,i)=>({url:`https://example.org/${i}`,title:'Orion budget',
    body:'Orion budget is 25 billion in fiscal 2026',crawlDate:'2026-06-01T00:00:00Z'})));writer.close();
  await buildFrozenIndex(source,index,anchor,{minimumFreeBytes:0});
  const pool=new FrozenWorkerPool({corpusPath:index,workers:2,sharedCachePath:join(dir,'eight.db'),sharedCacheSlots:8});
  try {
    assert.equal((await pool.search('Orion budget',anchor,5)).length,1);
    assert.equal(frozenCacheSlots(join(dir,'eight.db')),8);
    assert.throws(()=>new CorpusStore(index,'concept','auto',{sharedFrozenCachePath:join(dir,'eight.db'),sharedFrozenCacheSlots:4}),/configuration differs/);
  }
  finally {pool.close();}
  const base=new CorpusStore(index,'concept'),cached=new CorpusStore(index,'concept','auto',{sharedFrozenCachePath:join(dir,'cache.db')});
  try {
    for(const limit of [1,5,12,20]) {
      const expected=base.searchRaw('Orion AND budget',anchor,limit);
      assert.deepEqual(cached.searchRaw('Orion AND budget',anchor,limit),expected);
      assert.deepEqual(cached.searchRaw('Orion AND budget',anchor,limit),expected);
    }
    const rows=cached.searchRaw('Orion AND budget',anchor,20),plan=planQuery('Orion budget 2026',()=>12);
    const expected=rankAndDeduplicate(rows,plan,5);
    assert.deepEqual(cached.rankVerified(rows,plan,5),expected);
    const second=new CorpusStore(index,'concept','auto',{sharedFrozenCachePath:join(dir,'cache.db')});
    try {
      assert.deepEqual(second.rankVerified(rows,plan,5),expected);
      const changed=rows.map((r,i)=>i===0?{...r,body:'Different Orion budget estimates for 2026.'}:r);
      assert.deepEqual(second.rankVerified(changed,plan,5),rankAndDeduplicate(changed,plan,5));
      assert.deepEqual(second.rankVerified(rows,plan,2),rankAndDeduplicate(rows,plan,2));
    } finally {second.close();}
    assert.throws(()=>cached.searchRaw('Orion', '2026-06-01T00:00:00Z',5),/exact capture anchor/);
    const mutator=new DatabaseSync(source);mutator.prepare('UPDATE docs SET body=? WHERE id=12').run('changed captured body');mutator.close();
    assert.throws(()=>cached.searchRaw('Orion AND budget',anchor,20),/differs from captured bytes/);
  } finally {base.close();cached.close();rmSync(dir,{recursive:true,force:true});}
});

test('a crashed process cannot strand a shared computation slot',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'frozen-route-crash-')),path=join(dir,'cache.db');
  const module=new URL('./frozen-route-cache.ts',import.meta.url).href;
  try {
    await child(`import {FrozenRouteCache} from ${JSON.stringify(module)};
      const cache=new FrozenRouteCache(${JSON.stringify(path)},'shared');
      cache.getOrCompute('orphan',1,()=>{process.exit(0);});`);
    const cache=new FrozenRouteCache(path,'shared');
    try {assert.deepEqual(cache.getOrCompute('orphan',1,()=>[{rowid:1,rank:-1}]),[{rowid:1,rank:-1}]);}
    finally {cache.close();}
    const db=new DatabaseSync(path);assert.equal(db.prepare('SELECT COUNT(*) n FROM pending').get()!.n,0);db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

function child(code:string):Promise<void> {
  return new Promise((resolve,reject)=>{
    const proc=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
    let error='';proc.stderr.on('data',s=>error+=s);proc.on('error',reject);
    proc.on('exit',n=>n===0?resolve():reject(new Error(error)));
  });
}
test('independent processes share four slots and coalesce identical misses',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'frozen-route-processes-')),path=join(dir,'cache.db'),events=join(dir,'events.jsonl');
  writeFileSync(events,'');const cache=new FrozenRouteCache(path,'shared');cache.close();
  const module=new URL('./frozen-route-cache.ts',import.meta.url).href;
  const run=(key:string,id:number)=>child(`import {FrozenRouteCache} from ${JSON.stringify(module)};
    import {appendFileSync} from 'node:fs';
    const cache=new FrozenRouteCache(${JSON.stringify(path)},'shared');
    cache.getOrCompute(${JSON.stringify(key)},5,()=>{
      appendFileSync(${JSON.stringify(events)},JSON.stringify({phase:'start',id:${id},at:Date.now()})+'\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
      appendFileSync(${JSON.stringify(events)},JSON.stringify({phase:'end',id:${id},at:Date.now()})+'\\n');
      return [{rowid:1,rank:-1}];});cache.close();`);
  try {
    await Promise.all(Array.from({length:8},(_,i)=>run(`unique-${i}`,i)));
    await Promise.all(Array.from({length:4},(_,i)=>run('identical',100+i)));
    const rows=readFileSync(events,'utf8').trim().split('\n').map(x=>JSON.parse(x));
    let active=0,max=0;
    for(const e of rows) {active+=e.phase==='start'?1:-1;max=Math.max(max,active);assert.ok(active>=0);}
    assert.equal(active,0);assert.ok(max<=4);assert.ok(max>1);
    assert.equal(rows.filter(e=>e.id>=100 && e.phase==='start').length,1);
    const db=new DatabaseSync(path);assert.equal(db.prepare('SELECT COUNT(*) n FROM pending').get()!.n,0);db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('rank feature reuse preserves exact scores, observes changed bodies and stays bounded',()=>{
  const cache=new RankFeatureCache(256*1024),plan=planQuery('Orion fiscal 2026 revenue',()=>100);
  const docs=Array.from({length:12},(_,i)=>({url:`https://example.org/${i}`,title:'Orion fiscal report',
    body:`Orion fiscal 2026 revenue is ${i} million. `.repeat(60),crawlDate:'2026-06-01T00:00:00Z',score:-1}));
  const expected=rankAndDeduplicate(docs,plan,5);
  assert.deepEqual(rankAndDeduplicate(docs,plan,5,cache),expected);
  assert.deepEqual(rankAndDeduplicate(docs,plan,5,cache),expected);
  const small=docs.slice(-2);rankAndDeduplicate(small,plan,2,cache);rankAndDeduplicate(small,plan,2,cache);
  assert.ok(cache.snapshot().hits>0);
  docs[11]!.body='Changed figures: Orion fiscal 2026 revenue is 900 million.';
  assert.deepEqual(rankAndDeduplicate(docs,plan,5,cache),rankAndDeduplicate(docs,plan,5));
  assert.ok(cache.snapshot().accountedBytes<=cache.snapshot().maxBytes);
});
