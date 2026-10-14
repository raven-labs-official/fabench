import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SharedRateLimiter} from './shared-rate-limit.js';

test('real processes obey shared start spacing and capacity while draining HTTP failures',async(t)=>{
  const dir=mkdtempSync(join(tmpdir(),'fabench-admission-timing-')),db=join(dir,'state.sqlite');
  const limiter=new SharedRateLimiter(db),resource='loopback:timing';
  limiter.configureResources([{resource,concurrency:4,min_gap_ms:25,basis:'real transport test'}],'verify timing across processes');
  let active=0,peak=0,requests=0;
  const server=createServer((req,res)=>{
    req.resume();req.on('end',()=>{
      const fail=requests++===0;active++;peak=Math.max(peak,active);
      setTimeout(()=>{active--;res.writeHead(fail?500:200);res.end('done');},60);
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const endpoint='http://127.0.0.1:'+address.port;
  const script=`
    import {SharedRateLimiter} from ${JSON.stringify(new URL('./shared-rate-limit.ts',import.meta.url).href)};
    const s=new SharedRateLimiter(process.argv[1]),starts=[];let failures=0;
    try {
      await Promise.all(Array.from({length:16},async()=>{
        const permit=await s.acquire('loopback:timing',event=>{if(event.type==='shared_rate_admitted')starts.push(event.data.admitted_at_ms);});
        let success=false;
        try {const res=await fetch(process.argv[2]);await res.text();success=res.ok;if(!success)failures++;}
        finally {permit.release(success);}
      }));
      console.log(JSON.stringify({starts,failures}));
    }finally{s.close();}
  `;
  try {
    const runs=await Promise.all(Array.from({length:3},()=>promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',script,db,endpoint],{timeout:30000})));
    const receipts=runs.map(r=>JSON.parse(r.stdout));
    const starts:number[]=receipts.flatMap(r=>r.starts).sort((a,b)=>a-b);
    assert.equal(starts.length,48);assert.ok(starts.every(Number.isSafeInteger));
    const gaps=starts.slice(1).map((at,i)=>at-starts[i]!);
    assert.ok(gaps.every(ms=>ms>=25),JSON.stringify(gaps));
    assert.equal(receipts.reduce((n,r)=>n+r.failures,0),1);
    assert.equal(requests,48);assert.ok(peak<=4);assert.equal(active,0);
    assert.equal(limiter.snapshot().requests.length,0);
    t.diagnostic(JSON.stringify({processes:3,requests,configured_gap_ms:25,min_actual_admission_gap_ms:Math.min(...gaps),peak_http:peak,failures:1}));
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));limiter.close();rmSync(dir,{recursive:true,force:true});}
});
