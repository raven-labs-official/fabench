/** A contentless FTS index whose statistics contain only observations before one anchor.
 * Text stays in the immutable source corpus; per-document hashes verify every returned body.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { statSync,statfsSync,existsSync,openSync,closeSync,unlinkSync,writeFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { BodyCodec, decodeBody } from './body-codec.js';

export interface FrozenIndexMetadata {
  schema:'raven.frozen-index.v1'; status:'building'|'complete'; anchor:string;
  source:{path:string;size:number;mtimeMs:number}; documents:number; lastId:number;
  createdAt:string;updatedAt:string; sourceEligibleDocuments?:number;
}
export const capturedDocumentHash=(url:string,title:string,body:string,crawlDate:string)=>
  createHash('sha256').update(JSON.stringify([url,title,body,crawlDate])).digest();

export async function buildFrozenIndex(sourcePath:string,indexPath:string,anchor:string,opts:{
  batchSize?:number;minimumFreeBytes?:number;maxBatches?:number;onProgress?:(m:FrozenIndexMetadata)=>void;
  signal?:AbortSignal;
}={}) {
  sourcePath=resolve(sourcePath);indexPath=resolve(indexPath);
  if(sourcePath===indexPath)throw new Error('source and frozen index must be distinct');
  if(!/^\d{4}-\d{2}-\d{2}T/.test(anchor)||!Number.isFinite(Date.parse(anchor)))throw new Error('exact anchor timestamp required');
  anchor=new Date(anchor).toISOString();
  const batch=opts.batchSize??5000;
  if(!Number.isInteger(batch)||batch<1)throw new Error('positive batch size required');
  const minFree=opts.minimumFreeBytes??12*1024**3;
  const lockPath=indexPath+'.build-lock';
  const lock=openSync(lockPath,'wx',0o664);
  writeFileSync(lock,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),indexPath})+'\n');closeSync(lock);
  let source:DatabaseSync|undefined,index:DatabaseSync|undefined;
  try {
    const st=statSync(sourcePath),identity={path:sourcePath,size:st.size,mtimeMs:st.mtimeMs};
    source=new DatabaseSync(sourcePath,{readOnly:true});
    // A compacted source stores encoded bodies; index and hash the original text.
    const codec=BodyCodec.load(source);
    const existed=existsSync(indexPath);
    index=new DatabaseSync(indexPath);
    if(existed&&!index.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='frozen_index_metadata'").get())
      throw new Error('destination exists and is not a resumable frozen index');
    index.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-32768;
      CREATE TABLE IF NOT EXISTS frozen_index_metadata (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS frozen_documents (id INTEGER PRIMARY KEY, body_sha256 BLOB NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(title,body,content='');
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_vocab USING fts5vocab(docs_fts,'row');`);
    const prior=index.prepare('SELECT json FROM frozen_index_metadata WHERE id=1').get() as {json:string}|undefined;
    const now=new Date().toISOString();
    let meta:FrozenIndexMetadata=prior?JSON.parse(prior.json):{schema:'raven.frozen-index.v1',status:'building',anchor,source:identity,documents:0,lastId:0,createdAt:now,updatedAt:now};
    if(meta.schema!=='raven.frozen-index.v1'||meta.anchor!==anchor||JSON.stringify(meta.source)!==JSON.stringify(identity))throw new Error('source or anchor changed; refusing to mix captures');
    const save=index.prepare('INSERT OR REPLACE INTO frozen_index_metadata(id,json) VALUES(1,?)');
    save.run(JSON.stringify(meta));
    if(meta.status==='complete')return meta;
    const docs=source.prepare('SELECT id,url,title,body,crawl_date FROM docs NOT INDEXED WHERE id>? AND crawl_ms<? ORDER BY id LIMIT ?');
    const insert=index.prepare('INSERT INTO docs_fts(rowid,title,body) VALUES(?,?,?)');
    const hash=index.prepare('INSERT INTO frozen_documents(id,body_sha256) VALUES(?,?)');
    let batches=0;
    while(true) {
      if(opts.signal?.aborted)throw new Error('build interrupted; committed checkpoint can be resumed');
      const fs=statfsSync(dirname(indexPath));
      if(fs.bavail*fs.bsize<minFree)throw new Error('insufficient disk reserve; checkpoint kept for resume');
      const current=statSync(sourcePath);
      if(current.size!==identity.size||current.mtimeMs!==identity.mtimeMs)throw new Error('source changed during build');
      let added=0;
      index.exec('BEGIN IMMEDIATE');
      try {
        for(const raw of docs.iterate(meta.lastId,Date.parse(anchor),batch)) {
          const d=raw as {id:number;url:string;title:string;body:unknown;crawl_date:string};
          const body=decodeBody(d.body,codec);
          insert.run(d.id,d.title,body);hash.run(d.id,capturedDocumentHash(d.url,d.title,body,d.crawl_date));
          meta.lastId=d.id;meta.documents++;added++;
        }
        meta.updatedAt=new Date().toISOString();save.run(JSON.stringify(meta));index.exec('COMMIT');
      } catch(e) {index.exec('ROLLBACK');throw e;}
      index.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      opts.onProgress?.({...meta});
      batches++;
      if(added===0)break;
      if(opts.maxBatches && batches>=opts.maxBatches)return meta;
      await new Promise<void>(r=>setImmediate(r));
    }
    const eligible=(source.prepare('SELECT count(*) AS n FROM docs WHERE crawl_ms<?').get(Date.parse(anchor)) as {n:number}).n;
    const captured=(index.prepare('SELECT count(*) AS n FROM frozen_documents').get() as {n:number}).n;
    if(eligible!==meta.documents||captured!==eligible)throw new Error('frozen index document coverage mismatch');
    // This validates the contentless index structure without materializing the source bodies.
    index.exec("INSERT INTO docs_fts(docs_fts) VALUES('integrity-check')");
    const current=statSync(sourcePath);
    if(current.size!==identity.size||current.mtimeMs!==identity.mtimeMs)throw new Error('source changed before completion');
    meta={...meta,status:'complete',sourceEligibleDocuments:eligible,updatedAt:new Date().toISOString()};
    save.run(JSON.stringify(meta));index.exec('PRAGMA wal_checkpoint(TRUNCATE)');opts.onProgress?.(meta);return meta;
  } finally {index?.close();source?.close();if(existsSync(lockPath))unlinkSync(lockPath);}
}
