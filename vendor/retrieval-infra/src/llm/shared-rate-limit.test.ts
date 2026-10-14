import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { apiResource, RATE_POLICY, retryAfterMs, SharedRateLimiter, WIKIMEDIA_API_LIMIT } from "./shared-rate-limit.js";

test("quota identity groups model/provider aliases with the same endpoint credential, not unrelated resources",()=>{
  assert.equal(apiResource("deepseek","https://api.test/v1","secret"),apiResource("custom","https://api.test/v2","secret"));
  assert.notEqual(apiResource("a","https://api.test/v1","secret"),apiResource("a","https://api.test/v1","other"));
  assert.notEqual(apiResource("a","https://api.test/v1","secret"),apiResource("a","https://other.test/v1","secret"));
  assert.ok(!apiResource("a","https://api.test/v1","secret").includes("secret"));
});
test("Retry-After supports seconds and HTTP dates without shortening a long server cooldown",()=>{
  assert.equal(retryAfterMs("120",0),120000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:02:00 GMT",0),120000);
  assert.equal(retryAfterMs("bad",0),0);
  assert.equal(retryAfterMs("-1",1000),0);
});
test("429 slows other users and new processes; unrelated API resources remain available",()=>{
  const dir=mkdtempSync(join(tmpdir(),"fabench-quota-")); const path=join(dir,"state.sqlite");
  let now=1_000_000; const a=new SharedRateLimiter(path,()=>now); const b=new SharedRateLimiter(path,()=>now);
  try {
    const active=Array.from({length:10},(_,i)=>a.enqueue("shared",i%2?"bob":"alice",`run-${i}`));
    for(const token of active)assert.equal(a.tryAdmit(token).admitted,true);
    const state=a.limited(active[0]!,"120");
    assert.equal(state.cap,5); assert.equal(state.cooldown_until,now+120000);
    assert.equal(a.limited(active[1]!,"2").cap,5,"one burst does not repeatedly halve the cap");
    for(const token of active)a.release(token);
    const other=b.enqueue("shared","carol","other-run");
    assert.equal(b.tryAdmit(other).admitted,false);
    const unaffected=b.enqueue("unrelated","carol","unrelated-run");
    assert.equal(b.tryAdmit(unaffected).admitted,true);b.release(unaffected);
    const source=new URL("./shared-rate-limit.ts",import.meta.url).href;
    const child=execFileSync(process.execPath,["--import","tsx","--input-type=module","-e",
      `import {SharedRateLimiter} from ${JSON.stringify(source)};const s=new SharedRateLimiter(process.argv[1],()=>1000000);const t=s.enqueue('shared','third-process','third-run');console.log(JSON.stringify(s.tryAdmit(t)));s.release(t);s.close();`,path],{encoding:"utf8"});
    assert.equal(JSON.parse(child).admitted,false);
    now=state.cooldown_until+1;
    assert.equal(b.tryAdmit(other).admitted,true); b.release(other,true);
  } finally {a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});
test("FIFO admission, expired leases and gradual recovery work across independent handles",()=>{
  let now=1_000_000;const s=new SharedRateLimiter(":memory:",()=>now);
  try {
    const first=s.enqueue("api","a","1"),second=s.enqueue("api","b","2");
    assert.equal(s.tryAdmit(second).admitted,false);
    assert.equal(s.tryAdmit(first).admitted,true);assert.equal(s.tryAdmit(second).admitted,true);
    s.limited(first);s.release(first);s.release(second);
    now+=61_000;
    for(let i=0;i<10;i++) {const t=s.enqueue("api","a","1");assert.equal(s.tryAdmit(t).admitted,true);s.release(t,true);now+=1001;}
    const state=s.snapshot().resources[0] as any; assert.equal(state.cap,2);assert.equal(state.gap_ms,0);
    const dead=s.enqueue("other","gone","old");assert.equal(s.tryAdmit(dead).admitted,true);
    now+=RATE_POLICY.lease_ms+1;
    const next=s.enqueue("other","live","new");assert.equal(s.tryAdmit(next).admitted,true);
    assert.throws(()=>s.renew(dead),/lease is missing/);
    assert.equal((s.snapshot().requests as any[]).some(r=>r.owner==="gone"),false);s.release(next);
  } finally {s.close();}
});
test("Python reader uses the same persistent admission service and releases permits",()=>{
  const dir=mkdtempSync(join(tmpdir(),"fabench-python-quota-"));const path=join(dir,"state.sqlite");
  const root=fileURLToPath(new URL("../../",import.meta.url));
  const store=new SharedRateLimiter(path);
  try {
    const output=execFileSync("python3",["-c",
      "import sys,json; sys.path.insert(0,sys.argv[1]); from shared_api_admission import acquire; p=acquire('https://r.jina.ai/','test-reader-key'); p.release(); print(json.dumps({'ok':True}))",join(root,"tools")],{
      encoding:"utf8",timeout:15000,env:{...process.env,FABENCH_API_ADMISSION_DB:path,FABENCH_NODE_EXECUTABLE:process.execPath,
        FABENCH_TSX_LOADER:fileURLToPath(import.meta.resolve("tsx")),FABENCH_API_BRIDGE:join(root,"tools/api-admission-bridge.ts")},
    });
    assert.equal(JSON.parse(output).ok,true);
    const state=store.snapshot();assert.equal(state.requests.length,0);
    assert.equal((state.resources[0] as any).resource,apiResource("jina","https://r.jina.ai/","test-reader-key"));
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('configured capacity above 64 is shared across real processes and cannot change while leased',()=>{
  const dir=mkdtempSync(join(tmpdir(),'fabench-configured-quota-')),path=join(dir,'state.sqlite');
  const s=new SharedRateLimiter(path,()=>1000000);
  const limits=[{resource:'model',concurrency:128,min_gap_ms:0,basis:'test operating point'}];
  try {
    s.configureResources(limits,'cross-process capacity check','test');
    const tokens=Array.from({length:96},()=>s.enqueue('model','first','first'));
    for(const token of tokens)assert.equal(s.tryAdmit(token).admitted,true);
    assert.throws(()=>s.configureResources(limits,'must not change live policy'),/active or waiting/);
    const source=new URL('./shared-rate-limit.ts',import.meta.url).href;
    const output=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',
      `import {SharedRateLimiter} from ${JSON.stringify(source)};const s=new SharedRateLimiter(process.argv[1],()=>1000000);const ts=Array.from({length:33},()=>s.enqueue('model','second','second'));const results=ts.map(t=>s.tryAdmit(t).admitted);console.log(JSON.stringify(results));for(const t of ts)s.release(t);s.close();`,path],{encoding:'utf8'});
    assert.deepEqual(JSON.parse(output),[...Array(32).fill(true),false]);
    for(const token of tokens)s.release(token);
    assert.equal(s.snapshot().requests.length,0);
    s.configureResources([{...limits[0]!,concurrency:256}],'extend after draining','test');
    assert.equal((s.snapshot().resources[0] as any).cap,256);
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('start spacing, source floors and congestion reductions survive resource configuration',()=>{
  let now=1000000;const s=new SharedRateLimiter(':memory:',()=>now);
  try{
    assert.throws(()=>s.configureResources([
      {resource:'reader',concurrency:48,min_gap_ms:134,basis:'operating point'},
      {resource:WIKIMEDIA_API_LIMIT.resource,concurrency:2,min_gap_ms:0,basis:'invalid'}
    ],'atomic validation'),/Wikimedia/);
    assert.equal(s.snapshot().resource_limits.length,0);
    const limits={resource:'reader',concurrency:128,min_gap_ms:134,basis:'conservative account spacing'};
    s.configureResources([limits],'configure');
    const a=s.enqueue('reader','a','1'),b=s.enqueue('reader','b','2');
    assert.equal(s.tryAdmit(a).admitted,true);assert.equal(s.tryAdmit(b).admitted,false);
    now+=133;assert.equal(s.tryAdmit(b).admitted,false);
    now++;assert.equal(s.tryAdmit(b).admitted,true);
    const penalty=s.limited(a,'120');s.release(a);s.release(b);
    s.configureResources([{...limits,concurrency:256}],'larger ceiling must retain backoff');
    const state=s.snapshot().resources[0] as any;
    assert.equal(state.cap,penalty.cap);assert.equal(state.cooldown_until,penalty.cooldown_until);
    const c=s.enqueue('reader','c','3');assert.equal(s.tryAdmit(c).admitted,false);s.release(c);
  }finally{s.close();}
});

test('FIFO wake deadlines use available start slots without granting early permits',()=>{
  let now=1000000;const s=new SharedRateLimiter(':memory:',()=>now);
  try {
    s.configureResources([{resource:'search',concurrency:32,min_gap_ms:25,basis:'timing regression'}],'timing regression');
    const ts=Array.from({length:4},()=>s.enqueue('search','owner','run'));
    assert.equal(s.tryAdmit(ts[0]!).admitted,true);
    assert.equal(s.tryAdmit(ts[1]!).wait_ms,25);
    assert.equal(s.tryAdmit(ts[2]!).wait_ms,50);
    assert.equal(s.tryAdmit(ts[3]!).wait_ms,75);
    now+=24;assert.equal(s.tryAdmit(ts[1]!).admitted,false);
    now++;assert.equal(s.tryAdmit(ts[2]!).admitted,false,'later ticket must not jump the queue');
    assert.equal(s.tryAdmit(ts[1]!).admitted,true);
    assert.equal(s.tryAdmit(ts[2]!).wait_ms,25);
    s.release(ts[2]!);assert.equal(s.tryAdmit(ts[3]!).wait_ms,25,'cancelled waiter no longer occupies a start slot');
    now+=24;assert.equal(s.tryAdmit(ts[3]!).admitted,false);
    now++;assert.equal(s.tryAdmit(ts[3]!).admitted,true);
    s.release(ts[0]!);s.release(ts[1]!);s.release(ts[3]!);
    assert.equal(s.snapshot().requests.length,0);
  } finally {s.close();}
});
test('accurate start wakeups preserve concurrency caps, cooldown and lease cleanup',()=>{
  let now=1000000;const s=new SharedRateLimiter(':memory:',()=>now);
  try {
    s.configureResources([{resource:'search',concurrency:1,min_gap_ms:25,basis:'timing regression'}],'timing regression');
    const a=s.enqueue('search','a','1'),b=s.enqueue('search','b','2');
    assert.equal(s.tryAdmit(a).admitted,true);
    now+=25;assert.equal(s.tryAdmit(b).admitted,false,'start spacing cannot bypass an occupied concurrency slot');
    assert.equal(s.tryAdmit(b).wait_ms,100);
    const penalty=s.limited(a,'120');s.release(a);
    const held=s.tryAdmit(b);assert.equal(held.admitted,false);assert.equal(held.wait_ms,1000);
    now=penalty.cooldown_until-1;assert.equal(s.tryAdmit(b).admitted,false);
    now++;assert.equal(s.tryAdmit(b).admitted,true);s.release(b);
    assert.equal(s.snapshot().requests.length,0);
  } finally {s.close();}
});
test("admission commits skip the per-commit disk flush and reuse compiled statements",()=>{
  const dir=mkdtempSync(join(tmpdir(),"fabench-quota-sync-")); const path=join(dir,"state.sqlite");
  const limiter=new SharedRateLimiter(path);
  try {
    const db=(limiter as any).db;
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode,"wal");
    assert.equal(db.prepare("PRAGMA synchronous").get().synchronous,1,"NORMAL");
    const cycle=()=>{const token=limiter.enqueue("sync-test","owner","run");assert.equal(limiter.tryAdmit(token).admitted,true);limiter.release(token,true);};
    cycle();
    const compiled=(limiter as any).statements.size;
    for(let i=0;i<50;i++)cycle();
    assert.equal((limiter as any).statements.size,compiled,"repeated admissions add no new statements");
    assert.equal(Number((db.prepare("SELECT count(*) AS n FROM api_requests").get() as any).n),0);
  } finally { limiter.close(); rmSync(dir,{recursive:true,force:true}); }
});
