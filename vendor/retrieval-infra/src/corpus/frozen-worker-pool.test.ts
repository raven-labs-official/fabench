import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CorpusStore} from './store.js';
import {buildFrozenIndex} from './frozen-index.js';
import {FrozenWorkerPool} from './frozen-worker-pool.js';
import {queryFrozen} from './frozen-query.js';
import {withTiming,type TimingEvent} from '../observability/timeline.js';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {RetrievalInputError} from '../retrieval/input-error.js';
import {RetrievalInfrastructureError} from '../retrieval/infrastructure-error.js';
import {defaultFrozenWorkers} from './frozen-execution.js';

test('automatic pool sizing fits small hosts and caps the per-run default at four',()=>{
 assert.deepEqual([1,2,4,8,32].map(defaultFrozenWorkers),[1,2,4,4,4]);
 assert.throws(()=>defaultFrozenWorkers(0));
});

test('invalid browse input bypasses a full SQL queue and leaves the real pool usable',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'frozen-input-')),source=join(dir,'source.db'),index=join(dir,'index.db'),anchor='2026-03-01T00:00:00Z';
 const store=new CorpusStore(source,'concept','write');
 store.ingest(Array.from({length:3},(_,i)=>({url:`https://example.test/report/${i}`,title:'Orion report',body:`Original report ${i}.`,crawlDate:'2026-02-01T00:00:00Z'})));store.close();
 await buildFrozenIndex(source,index,anchor,{minimumFreeBytes:0});
 const pool=new FrozenWorkerPool({corpusPath:index,workers:1,maxQueue:1});
 try{
   // Submit before the real worker's ready event: the one-slot queue is full.
   const options={entity:'Orion',since:'2026-01-01',limit:1};
   const pending=pool.browse(options,anchor);
   const invalid=pool.browse({...options,cursor:'invalid'},anchor);
   assert.equal(pool.stats().queued,1);
   await assert.rejects(invalid,(e:unknown)=>e instanceof RetrievalInputError&&/original range/.test(e.message));
   const first=await pending;assert.ok(first.nextCursor);
   await assert.rejects(pool.browse({...options,since:'2026-02-01',cursor:first.nextCursor!},anchor),RetrievalInputError);
   await assert.rejects(pool.browse({...options,since:'2026-02-30'},anchor),RetrievalInputError);
   const next=await pool.browse({...options,cursor:first.nextCursor!},anchor);
   assert.notEqual(first.results[0]!.capturedId,next.results[0]!.capturedId);
   assert.equal(pool.stats().completed,2);assert.equal(pool.stats().queued,0);
   // An actual index/configuration mismatch remains fatal, rather than model feedback.
   await assert.rejects(pool.browse(options,'2026-04-01T00:00:00Z'),RetrievalInfrastructureError);
   assert.deepEqual(await pool.browse(options,anchor),first);
 }finally{pool.close();rmSync(dir,{recursive:true,force:true});}
});

test('a 64-question worst-case burst fits its explicit queue and overflow stays bounded',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'frozen-large-queue-')),path=join(dir,'index.db'),source=join(dir,'source.db');
 const store=new CorpusStore(source,'concept','write');
 store.ingest([{url:'https://example.test/report',title:'Orion report',body:'Historical complete body.',crawlDate:'2026-02-01T00:00:00Z'}]);store.close();
 await buildFrozenIndex(source,path,'2026-03-01T00:00:00Z',{minimumFreeBytes:0});
 const pool=new FrozenWorkerPool({corpusPath:path,workers:1,maxQueue:1280});
 try{
   // All requests are submitted synchronously before the real worker's ready event.
   const requests=Array.from({length:1280},()=>pool.getByUrlBefore('https://example.test/report','2026-03-01T00:00:00Z'));
   assert.equal(pool.stats().queued,1280);
   await assert.rejects(pool.getByUrlBefore('https://example.test/overflow','2026-03-01T00:00:00Z'),/full/);
   const results=await Promise.all(requests);
   assert.ok(results.every(result=>result?.body==='Historical complete body.'));
   assert.equal(pool.stats().completed,1280);
   assert.equal(pool.stats().queued,0);
 }finally{pool.close();rmSync(dir,{recursive:true,force:true});}
});

test('a real SQLite startup lock waits for its holder instead of failing the reader pool',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'frozen-startup-lock-')),path=join(dir,'index.db'),sourcePath=join(dir,'source.db');
 const source=new CorpusStore(sourcePath,'concept','write');
 source.ingest([{url:'https://example.test/history',title:'Orion',body:'Retained original report.',crawlDate:'2026-02-01T00:00:00Z'}]);source.close();
 await buildFrozenIndex(sourcePath,path,'2026-03-01T00:00:00Z',{minimumFreeBytes:0});
 const code=`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');console.log('locked');process.stdin.once('data',()=>{db.exec('ROLLBACK');db.close();process.stdin.destroy();});`;
 const holder=spawn(process.execPath,['--input-type=module','-e',code,path],{stdio:['pipe','pipe','pipe']});
 let pool:FrozenWorkerPool|undefined;
 try{
   await once(holder.stdout,'data');
   pool=new FrozenWorkerPool({corpusPath:path,workers:4});
   const pending=pool.search('Orion','2026-03-01T00:00:00Z');
   const release=setTimeout(()=>holder.stdin.end('release'),600);
   try {const result=await pending;assert.equal(result[0]?.body,'Retained original report.');}
   finally{clearTimeout(release);}
 }finally{holder.stdin.end();holder.kill();pool?.close();rmSync(dir,{recursive:true,force:true});}
});

test('an unused pool does not keep a failed preflight process alive',async()=>{
 const code=`import {FrozenWorkerPool} from ${JSON.stringify(new URL('./frozen-worker-pool.ts',import.meta.url).href)};new FrozenWorkerPool({corpusPath:'/unused-before-preflight.db'});`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
 let stderr='',expired=false;child.stderr.on('data',b=>stderr+=b);
 const deadline=setTimeout(()=>{expired=true;child.kill();},5000);
 try{const status=await new Promise(resolve=>child.once('exit',resolve));assert.equal(expired,false,'Idle worker prevented process exit');assert.equal(status,0,stderr);}
 finally{clearTimeout(deadline);}
});

test('workers preserve ranked bodies, page cursors and timing parentage, then release on close',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'frozen-pool-')),anchor='2026-03-01T00:00:00Z';
 let pool:FrozenWorkerPool|undefined,store:CorpusStore|undefined;
 try{
   const source=join(dir,'source.db'),index=join(dir,'index.db');store=new CorpusStore(source,'concept','write');
   store.ingest(Array.from({length:25},(_,i)=>({url:`https://example.test/${i}`,title:`Orion report ${i}`,body:'Original units and footnotes. '+('Full report. '.repeat(i+1)),crawlDate:'2026-02-01T00:00:00Z'})));store.close();
   await buildFrozenIndex(source,index,anchor,{minimumFreeBytes:0});store=new CorpusStore(index,'concept');pool=new FrozenWorkerPool({corpusPath:index,workers:8});
   const events:TimingEvent[]=[];
   const output=await withTiming({traceId:'test',questionId:'q1'},e=>events.push(e),()=>pool!.qualitySearch('Orion report',10,anchor));
   assert.deepEqual(output.hits,structuredClone(queryFrozen(store,undefined,'Orion report',10,anchor).hits));
   const options={entity:'Orion',limit:20},first=await pool.browse(options,anchor);assert.deepEqual(first,structuredClone(store.browse(options,anchor)));
   assert.deepEqual(await pool.browse({...options,cursor:first.nextCursor!},anchor),structuredClone(store.browse({...options,cursor:first.nextCursor!},anchor)));
   assert.ok(events.some(e=>e.stage==='frozen.query'&&e.questionId==='q1'&&e.parentId));
   for(const stage of ['frozen.plan','frozen.news','frozen.rank'])
     assert.ok(events.some(e=>e.stage===stage&&e.phase==='finished'&&e.questionId==='q1'&&e.parentId));
   const pending=pool.qualitySearch('Orion',5,anchor);pool.close();await assert.rejects(pending,/closed/);await assert.rejects(pool.qualitySearch('Orion',5,anchor),/closed/);
 }finally{pool?.close();store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('bounded queue rejects overflow, cancellation removes queued work, and a worker exit rejects all waiters',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'frozen-failure-')),path=join(dir,'db');const store=new CorpusStore(path,'concept','write');store.close();
 let pool=new FrozenWorkerPool({corpusPath:path,workers:1,maxQueue:1});
 try{
   const abort=new AbortController();const queued=pool.request({method:'search',args:['orion','2026-03-01T00:00:00Z',1]},abort.signal);
   await assert.rejects(pool.search('overflow','2026-03-01T00:00:00Z'),/full/);
   abort.abort(new Error('cancel queued'));await assert.rejects(queued,/cancel queued/);assert.equal(pool.stats().queued,0);
   const waiting=pool.search('orion','2026-03-01T00:00:00Z');const rejected=assert.rejects(waiting,/exited/);
   await (pool as any).slots[0].worker.terminate();await rejected;assert.equal(pool.stats().queued,0);
 }finally{pool.close();rmSync(dir,{recursive:true,force:true});}
});
