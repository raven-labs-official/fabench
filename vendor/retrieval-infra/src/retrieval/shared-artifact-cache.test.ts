import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {SharedArtifactCache} from './shared-artifact-cache.js';
import {EvidenceStore} from './evidence-store.js';

test('shared claim publishes the complete artifact graph once, with failed work retryable',async()=>{
  // This tests coalescing/publication, not a sub-second event-loop deadline. A
  // loaded CI host can deschedule the process for longer than the old 200ms lease.
  // Expired-producer takeover is exercised separately below.
  const dir=mkdtempSync(join(tmpdir(),'shared-review-')),a=new SharedArtifactCache(join(dir,'shared'),5000,10),b=new SharedArtifactCache(join(dir,'shared'),5000,10);
  const sa=new EvidenceStore(join(dir,'a')),sb=new EvidenceStore(join(dir,'b'));let calls=0;
  try{
    for(const path of [join(dir,'shared'),join(dir,'shared','artifacts')])assert.equal(statSync(path).mode&0o2770,0o2770);
    const make=(local:EvidenceStore)=>async()=>{calls++;await pause(400);const document=local.put({body:'Full table and footnotes'});const receipt=local.put({document,costUsd:0.04});return {receipt};};
    const [first,second]=await Promise.all([a.run('version',sa,make(sa),()=>true),b.run('version',sb,make(sb),()=>true)]);
    assert.equal(calls,1);assert.equal(first.reused,false);assert.equal(second.reused,true);
    const r=sb.get<{document:string}>(second.value.receipt);assert.equal(sb.get<any>(r.document).body,'Full table and footnotes');
    await assert.rejects(a.run('retry',sa,async()=>{throw new Error('interrupted');},()=>true),/interrupted/);
    assert.equal((await b.run('retry',sb,async()=>42,()=>true)).value,42);
    await a.run('unknown',sa,async()=>({status:'unknown'}),()=>true);
    assert.equal((await b.run('unknown',sb,async()=>({status:'supported'}),()=>true)).value.status,'unknown');
    await a.run('invalid',sa,async()=>0,()=>false);assert.equal((await b.run('invalid',sb,async()=>1,()=>true)).reused,false);
    writeFileSync(join(dir,'shared','artifacts',first.value.receipt+'.json'),'corrupt');
    await assert.rejects(b.run('version',sb,async()=>null,()=>true),/hash mismatch/);
  }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('another process takes over an expired claim after its producer exits',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cache-crash-'));
  const module=new URL('./shared-artifact-cache.ts',import.meta.url).href,storeModule=new URL('./evidence-store.ts',import.meta.url).href;
  const code=`import {SharedArtifactCache} from ${JSON.stringify(module)};import {EvidenceStore} from ${JSON.stringify(storeModule)};const c=new SharedArtifactCache(process.argv[1],200,10);await c.run('crash',new EvidenceStore(process.argv[2]),async()=>{process.stdout.write('claimed\\n');process.exit(23)},()=>true);`;
  try{
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code,join(dir,'shared'),join(dir,'producer')],{stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    const status=await new Promise(resolve=>child.once('exit',resolve));assert.equal(status,23,err);assert.match(out,/claimed/);
    const consumer=new SharedArtifactCache(join(dir,'shared'),200,10);
    try{assert.deepEqual(await consumer.run('crash',new EvidenceStore(join(dir,'consumer')),async()=>7,()=>true),{value:7,reused:false});}finally{consumer.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
