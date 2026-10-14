/** Append verified new CC shards atomically, with a per-WARC ledger for safe retry.
 * Explicit staged source only. Existing public corpora/releases are never selected implicitly.
 */
import {DatabaseSync} from 'node:sqlite';
import {createReadStream,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {hostOf,isJunkHost,wireSource} from '../src/corpus/domain-policy.js';
import {BodyCodec} from '../src/corpus/body-codec.js';
const [dbPath,shardsDir,baseReceipt,originalShardNames,outputFile]=process.argv.slice(2);
if(!dbPath||!shardsDir||!baseReceipt||!originalShardNames||!outputFile)throw new Error('db shards-dir source-copy-receipt old-shard-list output-receipt required');
const baseline=JSON.parse(readFileSync(baseReceipt,'utf8'));
const shared=baseline.purpose==='verified-shared-append';
if(baseline.status!=='complete'||resolve(dbPath)!==resolve(baseline.destination)||(!shared&&resolve(dbPath)===resolve(baseline.source)))throw new Error('staged source must match completed copy receipt and differ from public source');
const originals=new Set(readFileSync(originalShardNames,'utf8').trim().split('\n'));
const manifest=JSON.parse(readFileSync(shared?baseline.manifest:resolve(shardsDir,'manifest.json'),'utf8'));
if(manifest.status!=='complete'||!Array.isArray(manifest.shards)||!manifest.shards.length)throw new Error('complete nonempty shard manifest required');
const db=new DatabaseSync(dbPath);const rows:unknown[]=[];
try{
 if(!shared)db.exec('PRAGMA journal_mode=WAL');
 db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
 const journal=(db.prepare('PRAGMA journal_mode').get() as {journal_mode:string}).journal_mode;
 if(shared){
   const bounds=db.prepare('SELECT id FROM docs ORDER BY id DESC LIMIT 1').get() as {id:number}|undefined;
   if((bounds?.id??0)<baseline.last_existing_id)throw new Error('Source shrank since preflight');
 }
 db.exec('CREATE TABLE IF NOT EXISTS ccnews_shard_imports (warc_key TEXT PRIMARY KEY, sha256 TEXT NOT NULL, receipt TEXT NOT NULL)');
 const prior=db.prepare('SELECT sha256,receipt FROM ccnews_shard_imports WHERE warc_key=?');
 // A compacted corpus stores encoded bodies; the full-text index still receives the original text.
 const codec=BodyCodec.load(db);
 const ins=db.prepare('INSERT INTO main.docs(url,title,body,crawl_date,crawl_ms,wire,source) VALUES(?,?,?,?,?,?,?)');
 const fts=db.prepare('INSERT INTO docs_fts(rowid,title,body) VALUES(?,?,?)');
 const ledger=db.prepare('INSERT INTO ccnews_shard_imports(warc_key,sha256,receipt) VALUES(?,?,?)');
 for(const shard of manifest.shards){
  const name=basename(shard.key).replace('.warc.gz','.jsonl.gz');
  if(originals.has(name))throw new Error('refusing to re-import a shard already in the base source: '+name);
  const old=prior.get(shard.key) as {sha256:string,receipt:string}|undefined;
  if(old){if(old.sha256!==shard.sha256)throw new Error('imported shard identity changed');rows.push({...JSON.parse(old.receipt),reused:true});continue;}
  const file=resolve(shardsDir,name);if(!existsSync(file))throw new Error('missing verified shard: '+file);
  const hash=createHash('sha256');for await(const b of createReadStream(file))hash.update(b);
  if(hash.digest('hex')!==shard.sha256)throw new Error('shard hash mismatch: '+file);
  const docs:Array<{url:string,title:string,body:string,date:string,ms:number,wire:string|null}>=[];let parsed=0,junked=0;
  for await(const line of createInterface({input:createReadStream(file).pipe(createGunzip()),crlfDelay:Infinity})){
   if(!line.trim())continue;const r=JSON.parse(line);parsed++;const ms=Date.parse(r.crawlDate);
   if(typeof r.url!=='string'||typeof r.body!=='string'||typeof r.title!=='string'||!r.body||!Number.isFinite(ms)||ms>=Date.parse(manifest.capture_before)||shared&&ms<=baseline.last_capture_ms)throw new Error('invalid or out-of-period record');
   if(isJunkHost(hostOf(r.url))){junked++;continue;}
   docs.push({url:r.url,title:r.title,body:r.body,date:r.crawlDate,ms,wire:wireSource(r.body)??null});
  }
  if(parsed!==shard.documents)throw new Error('shard count mismatch');
  const info={key:shard.key,sha256:shard.sha256,parsed,junked,inserted:docs.length,first_capture_utc:shard.first_capture_utc,last_capture_utc:shard.last_capture_utc,committed_at_utc:new Date().toISOString()};
  db.exec('BEGIN IMMEDIATE');
  try{for(const d of docs){const id=ins.run(d.url,d.title,codec?codec.encode(d.body):d.body,d.date,d.ms,d.wire,'ccnews').lastInsertRowid;fts.run(id,d.title,d.body);}ledger.run(shard.key,shard.sha256,JSON.stringify(info));db.exec('COMMIT');}
  catch(e){db.exec('ROLLBACK');throw e;}
  if(journal==='wal')db.exec('PRAGMA wal_checkpoint(TRUNCATE)');rows.push(info);console.log(JSON.stringify(info));
 }
 const counts=db.prepare('SELECT count(*) n FROM docs WHERE id>?').get(baseline.last_existing_id);
 const latest=db.prepare('SELECT crawl_ms ms FROM docs ORDER BY crawl_ms DESC LIMIT 1').get();
 writeFileSync(outputFile,JSON.stringify({status:'complete',source:resolve(dbPath),capture_before:manifest.capture_before,rows,added_since_base:counts,latest_capture:latest,finished_at_utc:new Date().toISOString()},null,2)+'\n');
}finally{db.close();}
