import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,existsSync,chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname,userInfo } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { EvidenceStore } from './evidence-store.js';
import { timingSpan } from '../observability/timeline.js';
import { projectEnv } from "../env-names.js";

/** Receipts and their referenced JSON artifacts travel together. Raw files keep their public, immutable paths. */
export function copyArtifactGraph(id:string,source:EvidenceStore,target:EvidenceStore,seen=new Set<string>()) {
  if(seen.has(id))return;seen.add(id);const value=source.get(id);
  const visit=(v:unknown)=>{
    if(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)&&existsSync(join(source.directory,`${v}.json`)))copyArtifactGraph(v,source,target,seen);
    else if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')Object.values(v).forEach(visit);
  };
  visit(value);if(target.put(value)!==id)throw new Error('Shared artifact identity changed');
}
export class SharedArtifactCache {
  readonly artifacts:EvidenceStore;
  private db:DatabaseSync;private controllers=new Set<AbortController>();private closed=false;
  constructor(directory:string,private leaseMs=120_000,private pollMs=250){
    if(leaseMs<100||pollMs<1)throw new Error('Invalid cache lease');
    mkdirSync(directory,{recursive:true,mode:0o2770});
    try{chmodSync(directory,0o2770);}catch(error){if((error as NodeJS.ErrnoException).code!=='EPERM')throw error;}
    this.artifacts=new EvidenceStore(join(directory,'artifacts'));
    try{chmodSync(this.artifacts.directory,0o2770);}catch(error){if((error as NodeJS.ErrnoException).code!=='EPERM')throw error;}
    const path=join(directory,'claims.sqlite');this.db=new DatabaseSync(path);
    // As in the API admission database: consistent WAL without a disk flush on every commit.
    // A power loss can drop the newest claims or results, which only causes recomputation.
    this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS entries(key TEXT PRIMARY KEY, token TEXT, owner TEXT, host TEXT, pid INTEGER, run_id TEXT, lease_until INTEGER, result_id TEXT);
      CREATE TABLE IF NOT EXISTS events(at INTEGER,key TEXT,token TEXT,event TEXT);`);
    for(const f of [path,path+'-wal',path+'-shm'])if(existsSync(f))try{chmodSync(f,0o660);}catch{}
  }
  private event(key:string,token:string,event:string){this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(Date.now(),key,token,event);}
  async run<T>(key:string,local:EvidenceStore,work:(signal:AbortSignal)=>Promise<T>,cacheable:(value:T)=>boolean):Promise<{value:T;reused:boolean}> {
    if(this.closed)throw new Error('Shared cache is closed');
    const controller=new AbortController();this.controllers.add(controller);const token=randomUUID(),span=timingSpan('cache.claim');span.queued();
    let owned=false,timer:ReturnType<typeof setInterval>|undefined;
    try{
      while(true){
        controller.signal.throwIfAborted();
        const now=Date.now();this.db.exec('BEGIN IMMEDIATE');
        let resultId:string|undefined;
        try{
          const row=this.db.prepare('SELECT result_id,lease_until FROM entries WHERE key=?').get(key) as {result_id:string|null;lease_until:number}|undefined;
          if(row?.result_id)resultId=row.result_id;
          else if(!row||row.lease_until<=now){
            this.db.prepare(`INSERT INTO entries VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET
              token=excluded.token,owner=excluded.owner,host=excluded.host,pid=excluded.pid,run_id=excluded.run_id,lease_until=excluded.lease_until`).run(key,token,userInfo().username,hostname(),process.pid,projectEnv("FABENCH_ACTIVE_RUN_ID")??null,now+this.leaseMs);
            this.event(key,token,row?'takeover':'claimed');owned=true;
          }
          this.db.exec('COMMIT');
        }catch(error){this.db.exec('ROLLBACK');throw error;}
        if(resultId){
          copyArtifactGraph(resultId,this.artifacts,local);
          const saved=local.get<{key:string;value:T}>(resultId);if(saved.key!==key)throw new Error('Shared receipt key mismatch');
          span.admitted();span.start();span.end();return {value:saved.value,reused:true};
        }
        if(owned)break;
        await pause(this.pollMs,undefined,{signal:controller.signal});
      }
      span.admitted();span.start();
      timer=setInterval(()=>{
        try{const changed=this.db.prepare('UPDATE entries SET lease_until=? WHERE key=? AND token=? AND result_id IS NULL AND lease_until>?').run(Date.now()+this.leaseMs,key,token,Date.now());
          if(Number(changed.changes)!==1)throw new Error('Shared cache lease lost');
        }catch(error){controller.abort(error);}
      },Math.max(25,Math.floor(this.leaseMs/4)));
      const value=await span.run(()=>work(controller.signal));controller.signal.throwIfAborted();
      if(cacheable(value)){
        const id=local.put({key,value});copyArtifactGraph(id,local,this.artifacts);
        const changed=this.db.prepare('UPDATE entries SET result_id=?,lease_until=0 WHERE key=? AND token=? AND lease_until>?').run(id,key,token,Date.now());
        if(Number(changed.changes)!==1)throw new Error('Cannot publish after shared lease expiry');
        this.event(key,token,'completed');owned=false;
      }
      span.end();return {value,reused:false};
    }catch(error){span.end(error);throw error;}
    finally{
      if(timer)clearInterval(timer);
      if(owned){this.db.prepare('DELETE FROM entries WHERE key=? AND token=? AND result_id IS NULL').run(key,token);this.event(key,token,'released');}
      this.controllers.delete(controller);if(this.closed&&!this.controllers.size)this.db.close();
    }
  }
  close(){if(this.closed)return;this.closed=true;for(const c of this.controllers)c.abort(new Error('Shared cache is closed'));if(!this.controllers.size)this.db.close();}
}
