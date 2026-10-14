import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { timedSync, timingSpan } from '../observability/timeline.js';

export type FrozenRouteRow = { rowid: number; rank: number };
export const FROZEN_ROUTE_CACHE_POLICY = 'verified-fts-rowids-fifo-v1';
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Read the admitted shared capacity without changing or opening a writable cache. */
export function frozenCacheSlots(path:string):number {
  if(!existsSync(path))return 4;
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    const settings=db.prepare('SELECT policy,workers FROM settings WHERE id=1').get();
    if(settings?.policy!==FROZEN_ROUTE_CACHE_POLICY||!Number.isSafeInteger(settings.workers)||Number(settings.workers)<1||Number(settings.workers)>32)
      throw new Error('Invalid shared frozen cache capacity');
    return Number(settings.workers);
  } finally {db.close();}
}

function processIdentity(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').slice(1).join(') ').split(' ');
      if (stat[0] === 'Z') return null;
      return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat[19]}`;
    } catch (error) {
      if (['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error; // Do not steal a live request when another user's identity is unreadable.
    }
  }
  try { process.kill(pid, 0); return 'live'; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null; throw error; }
}

/** Shared metadata only: bodies are always reread through the verified corpus view.
 * Misses use FIFO admission and a single computation for an identical key. This
 * synchronous API belongs in retrieval workers, never the model/heartbeat loop.
 */
export class FrozenRouteCache {
  private readonly db: DatabaseSync;
  private readonly identity = processIdentity(process.pid)!;
  private hits = 0; private misses = 0;
  constructor(path: string, private readonly namespace: string,
    private readonly limits = { workers: 4, maxBytes: 64 * 1024 * 1024, maxEntries: 10000 },
    private readonly owner: string = randomUUID()) {
    if (!Number.isSafeInteger(limits.workers) || limits.workers < 1 || limits.workers > 32 ||
        !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 ||
        !Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1) throw new Error('Invalid frozen cache limits');
    mkdirSync(dirname(path), {recursive:true,mode:0o2770});
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL, workers INTEGER NOT NULL, max_bytes INTEGER NOT NULL, max_entries INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS routes(key TEXT PRIMARY KEY, payload TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, touched INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending(ticket INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, owner TEXT NOT NULL, pid INTEGER NOT NULL, identity TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS pending_key ON pending(key,active);
      CREATE INDEX IF NOT EXISTS routes_touched ON routes(touched);`);
    for(const filename of [path,path+'-wal',path+'-shm'])
      if(existsSync(filename) && statSync(filename).uid===process.getuid?.()) chmodSync(filename,0o660);
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES(1,?,?,?,?)').run(FROZEN_ROUTE_CACHE_POLICY,limits.workers,limits.maxBytes,limits.maxEntries);
    const settings = this.db.prepare('SELECT * FROM settings WHERE id=1').get()!;
    if (settings.policy !== FROZEN_ROUTE_CACHE_POLICY || settings.workers !== limits.workers ||
        settings.max_bytes !== limits.maxBytes || settings.max_entries !== limits.maxEntries) {
      this.db.close(); throw new Error('Shared frozen cache configuration differs; use the admitted shared limits');
    }
  }
  private read(key: string): FrozenRouteRow[] | undefined {
    const row = this.db.prepare('SELECT payload,sha256 FROM routes WHERE key=?').get(key) as {payload:string;sha256:string}|undefined;
    if (!row) return undefined;
    let rows: FrozenRouteRow[] | undefined;
    try {
      const value: unknown = JSON.parse(row.payload);
      if (hash(row.payload) === row.sha256 && Array.isArray(value) && value.every(r =>
        r && Number.isSafeInteger(r.rowid) && r.rowid > 0 && typeof r.rank === 'number' && Number.isFinite(r.rank))) rows=value;
    } catch { /* A damaged cache is disposable; never serve its data. */ }
    if (!rows) { this.db.prepare('DELETE FROM routes WHERE key=?').run(key); return undefined; }
    this.db.prepare('UPDATE routes SET touched=? WHERE key=?').run(Date.now(),key);
    return rows;
  }
  private write(key: string, rows: FrozenRouteRow[]) {
    const payload=JSON.stringify(rows), bytes=Buffer.byteLength(payload);
    if (bytes > this.limits.maxBytes) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR REPLACE INTO routes VALUES(?,?,?,?,?)').run(key,payload,hash(payload),bytes,Date.now());
      let usage=this.db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM routes').get() as {n:number;bytes:number};
      while(usage.n>this.limits.maxEntries || usage.bytes>this.limits.maxBytes) {
        this.db.exec('DELETE FROM routes WHERE key IN (SELECT key FROM routes ORDER BY touched,key LIMIT 1)');
        usage=this.db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM routes').get() as {n:number;bytes:number};
      }
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getOrCompute(expression: string, limit: number, compute: () => FrozenRouteRow[],kind:'route'|'rank'='route'): FrozenRouteRow[] {
    const stage=`frozen.${kind}`;
    const key=hash(JSON.stringify([FROZEN_ROUTE_CACHE_POLICY,this.namespace,kind,expression,limit]));
    const hit=this.read(key);
    if (hit) { this.hits++; return timedSync(stage+'.cache_hit',()=>hit); }
    const ticket=Number(this.db.prepare('INSERT INTO pending(key,owner,pid,identity) VALUES(?,?,?,?)').run(key,this.owner,process.pid,this.identity).lastInsertRowid);
    const wait=timingSpan(stage+'.shared_queue'); wait.queued();
    const deadline=Date.now()+600000;
    try {
      while(true) {
        const reused=this.read(key);
        if(reused) { wait.admitted();wait.start();wait.end();this.hits++;return timedSync(stage+'.cache_hit',()=>reused); }
        let admitted=false;
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const owners=this.db.prepare('SELECT DISTINCT pid,identity FROM pending').all() as {pid:number;identity:string}[];
          for(const owner of owners) if(processIdentity(owner.pid)!==owner.identity)
            this.db.prepare('DELETE FROM pending WHERE pid=? AND identity=?').run(owner.pid,owner.identity);
          const active=this.db.prepare('SELECT COUNT(*) AS n FROM pending WHERE active=1').get() as {n:number};
          const first=this.db.prepare(`SELECT p.ticket FROM pending p WHERE p.active=0 AND NOT EXISTS
            (SELECT 1 FROM pending busy WHERE busy.active=1 AND busy.key=p.key) ORDER BY p.ticket LIMIT 1`).get() as {ticket:number}|undefined;
          const duplicate=this.db.prepare('SELECT 1 FROM pending WHERE key=? AND active=1').get(key);
          if(active.n<this.limits.workers && first?.ticket===ticket && !duplicate) {
            this.db.prepare('UPDATE pending SET active=1 WHERE ticket=?').run(ticket); admitted=true;
          }
          this.db.exec('COMMIT');
        } catch(error) { this.db.exec('ROLLBACK');throw error; }
        if(admitted) break;
        if(Date.now()>deadline) throw new Error('Frozen shared query queue timed out');
        Atomics.wait(sleeper,0,0,25);
      }
      wait.admitted();wait.start();wait.end();
      // A winner may have populated the cache immediately before our transaction.
      const reused=this.read(key);
      if(reused) {this.hits++;return timedSync(stage+'.cache_hit',()=>reused);}
      this.misses++;
      const result=timedSync(stage+'.compute',compute);
      this.write(key,result);return result;
    } catch(error) {wait.end(error);throw error;}
    finally {this.db.prepare('DELETE FROM pending WHERE ticket=? AND owner=?').run(ticket,this.owner);}
  }
  snapshot() { return {hits:this.hits,misses:this.misses,policy:FROZEN_ROUTE_CACHE_POLICY,...this.limits}; }
  close() { this.db.prepare('DELETE FROM pending WHERE owner=?').run(this.owner);this.db.close(); }
}

/** Parent calls this only after the worker has terminated, including hard crashes. */
export function releaseFrozenCacheOwner(path:string,owner:string) {
  if(!existsSync(path)) return;
  const db=new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=10000');
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='pending'").get())
      db.prepare('DELETE FROM pending WHERE owner=?').run(owner);
  } finally {db.close();}
}
