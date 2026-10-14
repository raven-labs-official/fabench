import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PageDater} from './page-dater.js';
import {withTiming,type TimingEvent} from '../observability/timeline.js';

test('real dispatch queue remains live beyond the request inactivity deadline; a stalled active fetch still times out',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'fabench-dispatch-liveness-'));
  const requested:string[]=[];
  const server=createServer((request,response)=>{
    requested.push(request.url!);
    if(request.url?.startsWith('/stalled'))return;
    setTimeout(()=>{
      response.writeHead(200,{'content-type':'text/html'});
      response.end(`<html><head><title>Historical evidence</title><meta property="article:published_time" content="2026-01-01T00:00:00Z"></head><body><article><h1>Historical evidence</h1>${'<p>The original report describes observations and the methods used to measure them.</p>'.repeat(40)}<p>COMPLETE ${request.url}</p></article></body></html>`);
    },650);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const makeDater=()=>new PageDater(false,process.env.HTMLDATE_PYTHON??'python3',undefined,1500,
    {policy:'article-blocks-tables-v1',rawDirectory:directory},
    {fetchConcurrency:1,dispatchConcurrency:1});
  try{
    const dater=makeDater();
    try{
      await dater.assertReady();
      const started=performance.now();
      const events:TimingEvent[]=[];
      const pages=await withTiming({},event=>events.push(event),()=>Promise.all(Array.from({length:4},(_,i)=>dater.fetchMany([`http://127.0.0.1:${address.port}/page-${i}`]))));
      assert.ok(performance.now()-started>2500,'actual serialized HTTP work exceeds the inactivity deadline');
      for(let i=0;i<pages.length;i++)assert.ok(pages[i]![0]!.text.includes(`COMPLETE /page-${i}`));
      assert.equal(dater.snapshot().helperHealthy,true);
      const admissions=events.filter(e=>e.stage==='page.helper.admission'&&e.phase==='admitted');
      assert.equal(admissions.length,4);
      const last=admissions.at(-1)!;
      const queued=events.find(e=>e.spanId===last.spanId&&e.phase==='queued')!;
      assert.ok(last.monotonicMs-queued.monotonicMs>1500,'time waiting before IPC is measured outside the response deadline');
      const firstFinish=events.find(e=>e.stage==='page.helper'&&e.phase==='finished')!;
      assert.ok(admissions[1]!.monotonicMs>=firstFinish.monotonicMs,'no second request enters the helper pipe before a slot is released');
    }finally{dater.close();}
    const stalled=makeDater();
    try{
      await stalled.assertReady();const started=performance.now();
      const results=await Promise.allSettled(Array.from({length:3},(_,i)=>stalled.fetchMany([`http://127.0.0.1:${address.port}/stalled-${i}`])));
      assert.ok(results.every(r=>r.status==='rejected'&&/made no progress within 1500ms/.test(String(r.reason))));
      assert.equal(requested.filter(url=>url.startsWith('/stalled')).length,1,'queued requests fail without being sent after helper failure');
      assert.ok(performance.now()-started<3000,'queue keepalive must not mask a stalled active request');
      assert.equal(stalled.snapshot().helperFailureCode,'helper_timeout');
    }finally{stalled.close();}
  }finally{
    server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    rmSync(directory,{recursive:true,force:true});
  }
});

test('a long local parse keeps its request alive within the parsing limit; beyond the limit the helper still times out',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'fabench-parse-liveness-'));
  const body=`<html><head><title>Flat page</title></head><body>${Array.from({length:40000},(_,i)=>`<p>Paragraph ${i} of a long flat page about measurements.</p>`).join('')}<p>FLAT COMPLETE</p></body></html>`;
  const server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'text/html'});response.end(body);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const saved=process.env.PAGE_DATER_CPU_STAGE_LIMIT_S;
  const makeDater=()=>new PageDater(false,process.env.HTMLDATE_PYTHON??'python3',undefined,1500,
    {policy:'article-blocks-tables-v1',rawDirectory:directory},{fetchConcurrency:2,dispatchConcurrency:2});
  try{
    const dater=makeDater();
    try{
      await dater.assertReady();
      const started=performance.now();
      const [page]=await dater.fetchMany([`http://127.0.0.1:${address.port}/flat`]);
      assert.ok(performance.now()-started>1500,'local parsing outlasts the inactivity deadline');
      assert.ok(page!.text.includes('FLAT COMPLETE')||page!.content_document?.usable!==undefined);
      assert.equal(dater.snapshot().helperHealthy,true);
    }finally{dater.close();}
    process.env.PAGE_DATER_CPU_STAGE_LIMIT_S='0.2';
    const limited=makeDater();
    try{
      await limited.assertReady();
      await assert.rejects(limited.fetchMany([`http://127.0.0.1:${address.port}/flat-limited`]),/made no progress within 1500ms/);
      assert.equal(limited.snapshot().helperFailureCode,'helper_timeout');
    }finally{limited.close();}
  }finally{
    if(saved===undefined)delete process.env.PAGE_DATER_CPU_STAGE_LIMIT_S;else process.env.PAGE_DATER_CPU_STAGE_LIMIT_S=saved;
    server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    rmSync(directory,{recursive:true,force:true});
  }
});
