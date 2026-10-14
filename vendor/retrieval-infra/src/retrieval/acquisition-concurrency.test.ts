import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PageDater,pageAcquisitionPolicy} from './page-dater.js';
import {withTiming,type TimingEvent} from '../observability/timeline.js';

test('acquisition settings resolve once and reject nonpositive or fractional capacities',()=>{
  assert.deepEqual(pageAcquisitionPolicy({},{}),{fetch_concurrency:48,reader_concurrency:16,reader_rpm:400,dispatch_concurrency:64});
  assert.equal(pageAcquisitionPolicy({readerConcurrency:64},{JINA_CONCURRENCY:'16'}).reader_concurrency,64);
  for(const field of ['fetchConcurrency','readerConcurrency','readerRpm','dispatchConcurrency']){
    for(const bad of [0,-1,1.5,Infinity,NaN])assert.throws(()=>pageAcquisitionPolicy({[field]:bad},{}),/positive safe integer/);
  }
});

test('real Python helper honors fetch and dispatch pools through HTTP and preserves complete pages',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'fabench-real-acquisition-'));
  let active=0,peak=0;
  const server=createServer((request,response)=>{
    active++;peak=Math.max(peak,active);
    setTimeout(()=>{
      response.writeHead(200,{'content-type':'text/html'});
      response.end(`<html><head><title>Pool measurement</title><meta property="article:published_time" content="2026-01-01T00:00:00Z"></head><body><article><h1>Pool measurement</h1>${'<p>The historical article records observations and the methodology for measuring results.</p>'.repeat(40)}<p>END OF ARTICLE ${request.url}</p></article></body></html>`);
      active--;
    },120);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  try{
    for(const [fetchConcurrency,dispatchConcurrency,expected] of [[2,4,2],[4,1,1]]){
      peak=0;
      const dater=new PageDater(false,process.env.HTMLDATE_PYTHON??'python3',undefined,120000,
        {policy:'article-blocks-tables-v1',rawDirectory:directory},
        {fetchConcurrency,dispatchConcurrency,readerConcurrency:64,readerRpm:480});
      try{
        await dater.assertReady();
        const events:TimingEvent[]=[];
        const pages=await withTiming({traceId:'real-helper'},event=>events.push(event),()=>Promise.all(Array.from({length:8},(_,i)=>dater.fetchMany([`http://127.0.0.1:${address.port}/page-${i}`]))));
        assert.equal(peak,expected);
        for(let i=0;i<pages.length;i++){
          assert.equal(pages[i]!.length,1);
          assert.ok(pages[i]![0]!.text.includes(`END OF ARTICLE /page-${i}`));
          assert.equal(pages[i]![0]!.source,'direct');
        }
        assert.equal(dater.configuration().concurrency.reader_rpm,480);
        for(const phase of ['queued','admitted','started','finished'])assert.equal(events.filter(e=>e.stage==='python.dispatch'&&e.phase===phase).length,8);
        if(dispatchConcurrency===1){
          const last=events.filter(e=>e.stage==='page.helper.admission'&&e.phase==='started').at(-1)!;
          const queued=events.find(e=>e.spanId===last.spanId&&e.phase==='queued')!;
          assert.ok(last.monotonicMs-queued.monotonicMs>500,'real dispatch wait is measured before the helper pipe');
        }
      }finally{dater.close();}
    }
  }finally{
    server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    rmSync(directory,{recursive:true,force:true});
  }
});
