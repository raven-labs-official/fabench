/** Immutable revision bytes plus separately frozen, exact-anchor selections.
 * A cached old revision is not evidence that it was the latest at another anchor.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdirSync, existsSync, statSync, chmodSync, openSync, closeSync, readSync, statfsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sha256 } from '../retrieval/evidence-store.js';
import type { RankedDocument } from './query-plan.js';
import { WIKI_PLAIN_TEXT_POLICY, wikitextToPlain } from './wiki-text.js';

export class WikiCacheIntegrityError extends Error {constructor(message:string,options?:ErrorOptions){super(message,options);this.name='WikiCacheIntegrityError';}}
export const WIKIPEDIA_CACHE_POLICY = 'immutable-revision-exact-anchor-v1';
export const WIKIPEDIA_RESOLUTION_POLICY = 'historical-redirect-chain-v1';
const MAX_WIKI_REDIRECTS = 5;
export type WikiTarget = { host: string; title?: string; revision?: string };
export type WikiRevision = { host: string; pageId: number; version: string; title: string; body: string;
  availableAt: string; acquiredAt: string; cachedAt: string; bodySha256: string; rawSha256: string; raw: string; endpoint: string; redirectTarget?: string };
export function wikiAnchor(anchor: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(anchor) || !Number.isFinite(Date.parse(anchor))) throw new Error('Wiki requires exact anchor');
  return new Date(anchor).toISOString();
}
export function wikiEndpoint(target: WikiTarget, anchor: string): string {
  wikiAnchor(anchor);
  if (!/^https:\/\/[a-z-]+\.wikipedia\.org$/.test(target.host) || (!target.title && !target.revision)) throw new Error('Invalid Wiki target');
  const p = new URLSearchParams({ action:'query',format:'json',formatversion:'2',prop:'revisions',rvprop:'ids|timestamp|sha1|slotsha1|contentmodel|content',rvslots:'main' });
  if (target.revision) {
    if (!/^[1-9]\d*$/.test(target.revision)) throw new Error('Invalid Wiki revision ID');
    p.set('revids',target.revision);
  } else {
    p.set('titles',target.title!); p.set('rvstart',new Date(Math.floor((Date.parse(anchor)-1)/1000)*1000).toISOString());
    p.set('rvdir','older');p.set('rvlimit','1');
  }
  return `${target.host}/w/api.php?${p}`;
}
export function parseWikiRevision(raw: string, target: WikiTarget, anchor: string, acquiredAt: string, endpoint = wikiEndpoint(target,anchor)): WikiRevision {
  wikiAnchor(anchor); wikiAnchor(acquiredAt);
  const data = JSON.parse(raw), pages = data.query?.pages;
  const page = pages?.[0], revision = page?.revisions?.[0], body = revision?.slots?.main?.content;
  if (data.error || !Array.isArray(pages) || pages.length !== 1 || page.missing || !Number.isSafeInteger(page.pageid) || page.pageid <= 0 ||
      page.revisions?.length !== 1 || !Number.isSafeInteger(revision?.revid) || revision.revid <= 0 ||
      (target.revision && String(revision.revid) !== target.revision) || typeof body !== 'string' || !body.trim() ||
      revision.slots.main.contentmodel !== 'wikitext' || !Number.isFinite(Date.parse(revision.timestamp)) ||
      Date.parse(revision.timestamp) >= Date.parse(anchor) || Date.parse(revision.timestamp) > Date.parse(acquiredAt)) throw new Error('No matching pre-anchor Wiki revision');
  const isRedirect = /^\s*#redirect\b/i.test(body);
  const redirectTarget = isRedirect ? /^\s*#redirect\s*\[\[([^\]\[|\n]+)\]\]/i.exec(body)?.[1]?.split('#')[0]?.trim() : undefined;
  if(isRedirect && (!redirectTarget || /^(?:https?:|\/\/)/i.test(redirectTarget))) throw new Error('Unsupported historical Wiki redirect');
  const hex = createHash('sha1').update(body).digest('hex');
  if (![hex,BigInt(`0x${hex}`).toString(36)].includes(revision.slots.main.sha1 ?? revision.sha1)) throw new Error('Wiki revision SHA-1 mismatch');
  return { host:target.host,pageId:page.pageid,version:String(revision.revid),
    title:/'''([^'\n]{1,160})'''/.exec(body)?.[1] ?? 'Historical Wikipedia article',body,
    availableAt:revision.timestamp,acquiredAt,cachedAt:acquiredAt,bodySha256:sha256(body),rawSha256:sha256(raw),raw,endpoint,
    ...(redirectTarget ? {redirectTarget} : {}) };
}

/** Resolve every hop from its own pre-anchor revision, never API redirects=1. */
export async function resolveWikiDocument(target:WikiTarget,anchor:string,get:(url:string)=>Promise<string>,cache?:WikipediaCache):Promise<{revision:WikiRevision;redirects:WikiRevision[]}> {
  const redirects:WikiRevision[]=[],seen=new Set<string>();
  for(let hop=0;hop<=MAX_WIKI_REDIRECTS;hop++){
    const endpoint=wikiEndpoint(target,anchor);
    const revision=cache ? await cache.resolve(target,anchor,get)
      : parseWikiRevision(await get(endpoint),target,anchor,new Date().toISOString(),endpoint);
    const key=JSON.stringify([revision.host,revision.version]);
    if(seen.has(key))throw new Error('Historical Wiki redirect cycle');seen.add(key);
    if(!revision.redirectTarget)return {revision,redirects};
    redirects.push(revision);target={host:revision.host,title:revision.redirectTarget};
  }
  throw new Error('Historical Wiki redirect chain exceeds five hops');
}
/** Optional, opt-in presentation of a pinned snapshot. Manifests without it keep the original
 * behaviour: wikitext bodies, lead-bold titles and exact-URL fetches only. */
export const WIKI_PRESENTATION_POLICY = 'wiki-presentation-v1';
export type WikiPresentation = { policy: typeof WIKI_PRESENTATION_POLICY; body: typeof WIKI_PLAIN_TEXT_POLICY };
export type WikiManifest = { policy: typeof WIKIPEDIA_CACHE_POLICY; anchor: string; presentation?: WikiPresentation; revisions: {
  host:string; pageId:number; version:string; bodySha256:string; availableAt:string; cachedAt:string;
  /** With a presentation: the title shown to the model, its evidence, and titles that open the page. */
  title?:string; titleSource?:string; aliases?:string[];
}[] };

/** Canonical lookup key for a Wikipedia title: underscores as spaces, NFC, first letter upper case. */
export function wikiTitleKey(host:string,title:string):string|null {
  let t=title.split('#')[0]!.replaceAll('_',' ').normalize('NFC').replace(/\s+/g,' ').trim();
  if(!t)return null;
  t=t[0]!.toUpperCase()+t.slice(1);
  return `${host}\n${t}`;
}
/** Key for an ordinary article address (desktop or mobile, /wiki/ or index.php?title=); null for
 * revision addresses and anything that is not a Wikipedia article. */
export function wikiUrlKey(url:string):string|null {
  let u:URL;try{u=new URL(url);}catch{return null;}
  const m=/^([a-z-]+)(?:\.m)?\.wikipedia\.org$/.exec(u.hostname);if(!m)return null;
  let title:string|null=null;
  if(u.pathname.startsWith('/wiki/'))title=u.pathname.slice(6);
  else if(u.pathname==='/w/index.php'&&!u.searchParams.has('oldid'))title=u.searchParams.get('title');
  if(!title)return null;
  try{title=decodeURIComponent(title);}catch{/* keep the literal title */}
  return wikiTitleKey(`https://${m[1]}.wikipedia.org`,title);
}
const looseText=(s:string)=>s.replaceAll('_',' ').replace(/\s+/g,' ').trim().toLowerCase();
/** The page title as of acquisition is shown only when the pre-anchor text itself contains it
 * (or its name without a disambiguation suffix); a later rename must not reach the model. */
export function chooseWikiTitle(pageTitle:string,body:string,leadBold:string):{title:string;source:string} {
  const text=looseText(body);
  if(text.includes(looseText(pageTitle)))return {title:pageTitle,source:'page-title-in-text'};
  const base=pageTitle.replace(/\s*\([^()]*\)\s*$/,'');
  if(base!==pageTitle&&base.length>2&&text.includes(looseText(base)))return {title:pageTitle,source:'page-title-base-in-text'};
  if(leadBold!=='Historical Wikipedia article'&&leadBold.length>=2&&leadBold.length<=120&&/\p{L}/u.test(leadBold)&&!/[{}\[\]|<>=]/.test(leadBold))
    return {title:leadBold,source:'lead-bold'};
  const lead=wikitextToPlain(body).split('\n').find(l=>l.trim())??'Wikipedia article';
  return {title:lead.length>80?lead.slice(0,lead.lastIndexOf(' ',80)>20?lead.lastIndexOf(' ',80):80)+'…':lead,source:'lead-text'};
}

export class WikipediaCache {
  private db: DatabaseSync;
  private pending = new Map<string,Promise<WikiRevision>>();
  readonly path: string;
  constructor(path: string, private readonly readOnly = false,
    private readonly beforeInsert?: (compressedRevisionBytes: number) => void) {
    this.path=resolve(path); if (!readOnly) mkdirSync(dirname(this.path),{recursive:true,mode:0o2770});
    const existing=existsSync(this.path)&&statSync(this.path).size>0;
    this.db=new DatabaseSync(this.path,{readOnly});
    // Wait for a concurrent writer before the first read; otherwise a worker opening the cache while a
    // Wiki preparation writes to it fails at once with "database is locked".
    this.db.exec('PRAGMA busy_timeout=10000');
    if(existing&&!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wiki_revisions'").get()){this.db.close();throw new WikiCacheIntegrityError('Existing file is not a Wiki cache');}
    if (!readOnly) this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS wiki_revisions(host TEXT,version TEXT,page_id INTEGER,body_hash TEXT,raw_hash TEXT,record BLOB,PRIMARY KEY(host,version));
      CREATE TABLE IF NOT EXISTS wiki_selections(host TEXT,selector TEXT,anchor TEXT,version TEXT,selected_at TEXT,PRIMARY KEY(host,selector,anchor));`);
    if (!readOnly) for (const file of [this.path,this.path+'-wal',this.path+'-shm']) {
      if(existsSync(file))try{chmodSync(file,0o660);}catch{/* An existing team-owned cache may belong to another writer. */}
    }
  }
  get(host:string,version:string): WikiRevision | null {
    try {
    const row=this.db.prepare('SELECT record,body_hash,raw_hash FROM wiki_revisions WHERE host=? AND version=?').get(host,version) as {record:Uint8Array;body_hash:string;raw_hash:string}|undefined;
    if (!row) return null;
    const d=JSON.parse(gunzipSync(row.record,{maxOutputLength:12_000_000}).toString('utf8')) as WikiRevision;
    if(d.host!==host||d.version!==version||sha256(d.body)!==row.body_hash||sha256(d.raw)!==row.raw_hash||d.bodySha256!==row.body_hash||d.rawSha256!==row.raw_hash) throw new Error('Wiki cache hash/identity mismatch');
    const verified=parseWikiRevision(d.raw,{host,revision:version},new Date(Date.parse(d.availableAt)+1000).toISOString(),d.acquiredAt,d.endpoint);
    if(verified.pageId!==d.pageId||verified.title!==d.title||verified.redirectTarget!==d.redirectTarget||verified.bodySha256!==d.bodySha256||verified.availableAt!==d.availableAt||!Number.isFinite(Date.parse(d.cachedAt))||Date.parse(d.cachedAt)<Date.parse(d.acquiredAt)) throw new Error('Wiki cached metadata mismatch');
    return d;
    }catch(error){throw new WikiCacheIntegrityError('Wiki cache cannot verify revision',{cause:error});}
  }
  revisionBytes(host:string,version:string):number {
    const row=this.db.prepare('SELECT length(record) AS bytes FROM wiki_revisions WHERE host=? AND version=?').get(host,version) as {bytes:number}|undefined;
    if(!row)throw new WikiCacheIntegrityError('Missing Wiki revision');return row.bytes;
  }
  async resolve(target:WikiTarget,anchor:string,get:(url:string)=>Promise<string>):Promise<WikiRevision> {
    anchor=wikiAnchor(anchor);wikiEndpoint(target,anchor);
    const selector=target.revision?`revision:${target.revision}`:`title:${target.title!.normalize('NFC').replaceAll('_',' ')}`;
    const selected=this.db.prepare('SELECT version FROM wiki_selections WHERE host=? AND selector=? AND anchor=?').get(target.host,selector,anchor) as {version:string}|undefined;
    if(selected){const d=this.get(target.host,selected.version);if(!d||Date.parse(d.availableAt)>=Date.parse(anchor))throw new WikiCacheIntegrityError('Invalid Wiki selection');return d;}
    const key=JSON.stringify([target.host,selector,anchor]);const pending=this.pending.get(key);if(pending)return pending;
    if(this.readOnly) throw new Error('Wiki selection is not cached for this anchor');
    const work=(async()=>{
      const endpoint=wikiEndpoint(target,anchor);
      const prior=target.revision?this.get(target.host,target.revision):null;
      const d=prior??parseWikiRevision(await get(endpoint),target,anchor,new Date().toISOString(),endpoint);
      if(Date.parse(d.availableAt)>=Date.parse(anchor))throw new Error('Cached Wiki revision is after anchor');
      return this.storeSelection(target,anchor,d);
    })().finally(()=>this.pending.delete(key));this.pending.set(key,work);return work;
  }
  /** Inspect an exact-anchor selection without network, schema changes, or writes. */
  selected(target:WikiTarget,anchor:string):WikiRevision|null {
    anchor=wikiAnchor(anchor);wikiEndpoint(target,anchor);
    const selector=target.revision?`revision:${target.revision}`:`title:${target.title!.normalize('NFC').replaceAll('_',' ')}`;
    const row=this.db.prepare('SELECT version FROM wiki_selections WHERE host=? AND selector=? AND anchor=?').get(target.host,selector,anchor) as {version:string}|undefined;
    return row?this.finalCachedRevision(target.host,row.version,anchor):null;
  }
  /** Import a real archived API capture with its original acquisition timestamp. */
  importCapture(target:WikiTarget,anchor:string,raw:string,acquiredAt:string,endpoint:string):WikiRevision {
    const d=parseWikiRevision(raw,target,anchor,acquiredAt,endpoint);
    const actual=new URL(endpoint), expected=new URL(wikiEndpoint(target,anchor));
    if(actual.origin!==expected.origin||actual.pathname!==expected.pathname||actual.searchParams.get('prop')!=='revisions')throw new Error('Capture endpoint mismatch');
    if(target.revision ? actual.searchParams.get('revids')!==target.revision : actual.searchParams.get('titles')!==target.title ||
        actual.searchParams.get('rvdir')!=='older'||actual.searchParams.get('rvlimit')!=='1'||
        !Number.isFinite(Date.parse(actual.searchParams.get('rvstart')??''))||
        Math.abs(Date.parse(actual.searchParams.get('rvstart')??'')-Date.parse(anchor))>1000)throw new Error('Capture selection does not prove this anchor');
    d.cachedAt=new Date().toISOString();return this.storeSelection(target,wikiAnchor(anchor),d);
  }
  private storeSelection(target:WikiTarget,anchor:string,d:WikiRevision):WikiRevision {
    if(this.readOnly)throw new Error('Wiki cache is read only');
    const selector=target.revision?`revision:${target.revision}`:`title:${target.title!.normalize('NFC').replaceAll('_',' ')}`;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const existing=this.get(d.host,d.version);
      const compressed=existing?null:gzipSync(JSON.stringify(d));
      // The preparation guard runs inside the write transaction, including alias-only inserts.
      this.beforeInsert?.(compressed?.length??0);
      if(compressed)this.db.prepare('INSERT OR IGNORE INTO wiki_revisions VALUES(?,?,?,?,?,?)').run(d.host,d.version,d.pageId,d.bodySha256,d.rawSha256,compressed);
      const fixed=this.get(d.host,d.version)!;
      if(fixed.bodySha256!==d.bodySha256||fixed.pageId!==d.pageId)throw new Error('Immutable Wiki revision changed');
      this.db.prepare('INSERT OR IGNORE INTO wiki_selections VALUES(?,?,?,?,?)').run(d.host,selector,anchor,d.version,new Date().toISOString());
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    const selection=this.db.prepare('SELECT version FROM wiki_selections WHERE host=? AND selector=? AND anchor=?').get(target.host,selector,anchor) as {version:string};
    return this.get(target.host,selection.version)!;
  }
  manifest(anchor:string,targets?:WikiTarget[]): WikiManifest {
    anchor=wikiAnchor(anchor);
    const rows=targets?targets.flatMap(target=>{
      const selector=target.revision?`revision:${target.revision}`:`title:${target.title!.normalize('NFC').replaceAll('_',' ')}`;
      const row=this.db.prepare('SELECT host,version FROM wiki_selections WHERE host=? AND selector=? AND anchor=?').get(target.host,selector,anchor) as {host:string;version:string}|undefined;return row?[row]:[];
    }):this.db.prepare('SELECT DISTINCT host,version FROM wiki_selections WHERE anchor=? ORDER BY host,version').all(anchor) as {host:string;version:string}[];
    const pages=new Map<string,WikiRevision>();
    for(const row of rows){const d=this.finalCachedRevision(row.host,row.version,anchor);if(!d)continue;const key=JSON.stringify([d.host,d.pageId]);
      if(Date.parse(d.availableAt)>=Date.parse(anchor))throw new Error('Future Wiki selection');
      const prior=pages.get(key);if(!prior||Date.parse(d.availableAt)>Date.parse(prior.availableAt))pages.set(key,d);}
    return {policy:WIKIPEDIA_CACHE_POLICY,anchor,revisions:[...pages.values()].map(d=>({host:d.host,pageId:d.pageId,version:d.version,bodySha256:d.bodySha256,availableAt:d.availableAt,cachedAt:d.cachedAt})).sort((a,b)=>a.host.localeCompare(b.host)||a.pageId-b.pageId)};
  }
  /** Titles this cache resolved, at this anchor, to each member: directly or through redirect
   * revisions that themselves predate the anchor. Keys are host + newline + version. */
  anchorTitles(manifest:WikiManifest):Map<string,string[]> {
    const anchor=wikiAnchor(manifest.anchor),members=new Set(manifest.revisions.map(r=>`${r.host}\n${r.version}`));
    const titles=new Map<string,Set<string>>();
    const rows=this.db.prepare(`SELECT s.host,s.selector,s.version,length(r.record) AS bytes FROM wiki_selections s
      JOIN wiki_revisions r ON r.host=s.host AND r.version=s.version WHERE s.anchor=? AND s.selector LIKE 'title:%'`).all(anchor) as
      {host:string;selector:string;version:string;bytes:number}[];
    for(const row of rows){
      let key=`${row.host}\n${row.version}`;
      // Only small records can be redirect pages; resolving every large selection would be slow.
      if(!members.has(key)&&row.bytes<4096){const d=this.finalCachedRevision(row.host,row.version,anchor);if(d)key=`${d.host}\n${d.version}`;}
      if(!members.has(key))continue;
      const set=titles.get(key)??new Set<string>();set.add(row.selector.slice(6));titles.set(key,set);
    }
    return new Map([...titles].map(([k,v])=>[k,[...v].sort()]));
  }
  private finalCachedRevision(host:string,version:string,anchor:string):WikiRevision|null {
    const seen=new Set<string>();
    for(let hop=0;hop<=MAX_WIKI_REDIRECTS;hop++){
      if(seen.has(version))return null;seen.add(version);
      const d=this.get(host,version);if(!d)throw new WikiCacheIntegrityError('Missing selected Wiki revision');
      if(Date.parse(d.availableAt)>=Date.parse(anchor))throw new WikiCacheIntegrityError('Future Wiki redirect selection');
      if(!d.redirectTarget)return d;
      const selector=`title:${d.redirectTarget.normalize('NFC').replaceAll('_',' ')}`;
      const next=this.db.prepare('SELECT version FROM wiki_selections WHERE host=? AND selector=? AND anchor=?').get(host,selector,anchor) as {version:string}|undefined;
      if(!next)return null;version=next.version;
    }
    return null;
  }
  close(){this.db.close();}
}

const WIKI_INDEX_POLICY='wiki-contentless-fts-v1';
function manifestIdentity(manifest:WikiManifest){
  if(!manifest||!Array.isArray(manifest.revisions)||manifest.policy!==WIKIPEDIA_CACHE_POLICY||wikiAnchor(manifest.anchor)!==manifest.anchor)throw new Error('Invalid Wiki manifest');
  const p=manifest.presentation;
  if(p!==undefined){
    if(p.policy!==WIKI_PRESENTATION_POLICY||p.body!==WIKI_PLAIN_TEXT_POLICY||Object.keys(p).length!==2)throw new Error('Invalid Wiki presentation');
    for(const r of manifest.revisions)if(typeof r.title!=='string'||!r.title.trim()||!Array.isArray(r.aliases)||r.aliases.some(a=>typeof a!=='string'))
      throw new Error('Wiki presentation needs a title and aliases for every revision');
  }
  return {manifest:structuredClone(manifest),sha256:sha256(JSON.stringify(manifest))};
}
/** Adds verified display titles, opening aliases and a presentation policy to a fixed manifest.
 * The page set and revisions are unchanged; the result is a new manifest, hence a new condition. */
export function withWikiPresentation(cache:WikipediaCache,manifest:WikiManifest){
  manifestIdentity(manifest);
  const titles=cache.anchorTitles(manifest),sources:Record<string,number>={};let aliasCount=0;
  const revisions=manifest.revisions.map(r=>{
    const d=verifyMember(cache,r,manifest.anchor);
    const pageTitle=String(JSON.parse(d.raw).query.pages[0].title);
    const chosen=chooseWikiTitle(pageTitle,d.body,d.title);
    sources[chosen.source]=(sources[chosen.source]??0)+1;
    const aliases=[...new Set([...(titles.get(`${r.host}\n${r.version}`)??[]),pageTitle,chosen.title])].sort();
    aliasCount+=aliases.length;
    const {title:_t,titleSource:_s,aliases:_a,...base}=r;
    return {...base,title:chosen.title,titleSource:chosen.source,aliases};
  });
  const result:WikiManifest={policy:manifest.policy,anchor:manifest.anchor,presentation:{policy:WIKI_PRESENTATION_POLICY,body:WIKI_PLAIN_TEXT_POLICY},revisions};
  manifestIdentity(result);
  return {manifest:result,report:{revisions:revisions.length,titleSources:sources,aliases:aliasCount}};
}
/** Title and body that a snapshot searches and ranks. A presentation changes only the title here:
 * the original wikitext keeps every word the old manifests matched, so recall and ranking stay
 * comparable; the plain text is applied to what the model reads (`WikiSnapshot.present`). */
function indexed(d:WikiRevision,r:WikiManifest['revisions'][number],p:WikiPresentation|undefined){
  return {title:p?r.title!:d.title,body:d.body};
}
function aliasKeys(r:WikiManifest['revisions'][number]){
  return [...new Set([r.title!,...r.aliases!].map(a=>wikiTitleKey(r.host,a)).filter((k):k is string=>!!k))];
}
function verifyMember(cache:WikipediaCache,r:WikiManifest['revisions'][number],anchor:string){
  const d=cache.get(r.host,r.version);
  if(!d||d.redirectTarget||d.pageId!==r.pageId||d.bodySha256!==r.bodySha256||d.availableAt!==r.availableAt||d.cachedAt!==r.cachedAt||Date.parse(d.availableAt)>=Date.parse(anchor))throw new Error('Wiki manifest revision mismatch');
  return d;
}
function indexHash(file:string){
  const fd=openSync(file,'r'),hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);
  try{let n;while((n=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));return hash.digest('hex');}finally{closeSync(fd);}
}
/** Build a new, contentless FTS artifact. Bodies and raw captures stay in the shared cache. */
export function buildWikiIndex(cache:WikipediaCache,manifest:WikiManifest,outFile:string,limits:{minFreeBytes?:number;maxBytes?:number}={}){
  const identity=manifestIdentity(manifest),file=resolve(outFile),minFree=limits.minFreeBytes??10*1024**3,max=limits.maxBytes??4*1024**3;
  if(!Number.isSafeInteger(minFree)||minFree<0||!Number.isSafeInteger(max)||max<1)throw new Error('Invalid Wiki index disk limits');
  mkdirSync(dirname(file),{recursive:true,mode:0o2770});closeSync(openSync(file,'wx',0o660));
  let db:DatabaseSync|undefined;
  try{
    db=new DatabaseSync(file);db.exec(`PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA journal_mode=DELETE;
      CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE docs(id INTEGER PRIMARY KEY,url TEXT UNIQUE,title TEXT,crawlDate TEXT,host TEXT,version TEXT,pageId INTEGER,bodySha256 TEXT,cachedAt TEXT);
      CREATE VIRTUAL TABLE docs_fts USING fts5(title,body,content='');
      CREATE VIRTUAL TABLE docs_vocab USING fts5vocab(docs_fts,'row');`);
    if(manifest.presentation)db.exec('CREATE TABLE aliases(key TEXT PRIMARY KEY,id INTEGER NOT NULL)');
    const check=(reserve=0)=>{const fs=statfsSync(dirname(file));const bytes=statSync(file).size+(existsSync(file+'-journal')?statSync(file+'-journal').size:0);
      if(fs.bavail*fs.bsize-reserve<minFree||bytes+reserve>max)throw new Error('Wiki index disk budget reached');};
    const seen=new Set<string>();
    for(let start=0;start<manifest.revisions.length;start+=50){check();db.exec('BEGIN');
      try{for(const r of manifest.revisions.slice(start,start+50)){
        const key=JSON.stringify([r.host,r.pageId]);if(seen.has(key))throw new Error('Duplicate Wiki manifest member');seen.add(key);
        const d=verifyMember(cache,r,manifest.anchor);check(8*Buffer.byteLength(d.body)+1024*1024);
        const shown=indexed(d,r,manifest.presentation);
        const row=db.prepare('INSERT INTO docs(url,title,crawlDate,host,version,pageId,bodySha256,cachedAt) VALUES(?,?,?,?,?,?,?,?)')
          .run(`${d.host}/w/index.php?oldid=${d.version}`,shown.title,d.availableAt,d.host,d.version,d.pageId,d.bodySha256,d.cachedAt);
        db.prepare('INSERT INTO docs_fts(rowid,title,body) VALUES(?,?,?)').run(row.lastInsertRowid,shown.title,shown.body);
        if(manifest.presentation)for(const k of aliasKeys(r))db.prepare('INSERT OR IGNORE INTO aliases(key,id) VALUES(?,?)').run(k,row.lastInsertRowid);
      }db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    }
    check();db.exec("INSERT INTO docs_fts(docs_fts) VALUES('integrity-check')");
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('identity',JSON.stringify({policy:WIKI_INDEX_POLICY,manifestSha256:identity.sha256,documents:seen.size,status:'complete'}));
    db.close();db=undefined;check();
    return {file,sha256:indexHash(file),manifestSha256:identity.sha256,documents:seen.size,bytes:statSync(file).size,policy:WIKI_INDEX_POLICY};
  }catch(error){db?.close();for(const path of [file,file+'-journal'])if(existsSync(path))unlinkSync(path);throw error;}
}

/** Only the explicitly fixed manifest enters FTS statistics; disk mode hydrates hits on demand. */
export class WikiSnapshot {
  private db:DatabaseSync;
  private cache?:WikipediaCache;
  private snapshotIdentity: {manifest:WikiManifest;sha256:string;index?:{policy:string;sha256:string}};
  private readonly presentation?:WikiPresentation;
  private readonly members=new Map<string,WikiManifest['revisions'][number]>();
  get identity(){return structuredClone(this.snapshotIdentity);}
  constructor(cache:WikipediaCache, manifest:WikiManifest,indexFile?:string) {
    this.snapshotIdentity=manifestIdentity(manifest);
    this.presentation=manifest.presentation;
    for(const r of manifest.revisions)this.members.set(`${r.host}\n${r.version}`,r);
    this.db=new DatabaseSync(indexFile?resolve(indexFile):':memory:',{readOnly:!!indexFile});
    try{
    if(indexFile){
      this.db.exec('PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA query_only=ON');
      const row=this.db.prepare("SELECT value FROM metadata WHERE key='identity'").get() as {value:string}|undefined;
      const meta=JSON.parse(row?.value??'null');
      if(meta?.policy!==WIKI_INDEX_POLICY||meta.status!=='complete'||meta.manifestSha256!==this.snapshotIdentity.sha256||meta.documents!==manifest.revisions.length)throw new Error('Wiki index manifest mismatch');
      let i=0;const seen=new Set<string>();
      for(const row of this.db.prepare('SELECT * FROM docs ORDER BY id').iterate()){
        const r=manifest.revisions[i++],key=JSON.stringify([row.host,row.pageId]);
        if(!r||seen.has(key)||row.host!==r.host||row.version!==r.version||row.pageId!==r.pageId||row.bodySha256!==r.bodySha256||row.crawlDate!==r.availableAt||row.cachedAt!==r.cachedAt||row.url!==`${r.host}/w/index.php?oldid=${r.version}`||Date.parse(r.availableAt)>=Date.parse(manifest.anchor))throw new Error('Wiki index member mismatch');seen.add(key);
      }
      if(i!==manifest.revisions.length)throw new Error('Wiki index member count mismatch');
      this.cache=new WikipediaCache(cache.path,true);
      this.snapshotIdentity.index={policy:WIKI_INDEX_POLICY,sha256:indexHash(indexFile)};
      return;
    }
    this.db.exec(`CREATE TABLE docs(id INTEGER PRIMARY KEY,url TEXT UNIQUE,title TEXT,body TEXT,crawlDate TEXT);
      CREATE VIRTUAL TABLE docs_fts USING fts5(title,body);CREATE VIRTUAL TABLE docs_vocab USING fts5vocab(docs_fts,'row');`);
    if(this.presentation)this.db.exec('CREATE TABLE aliases(key TEXT PRIMARY KEY,id INTEGER NOT NULL)');
    const seen=new Set<string>();
    for(const r of manifest.revisions){const d=verifyMember(cache,r,manifest.anchor),key=JSON.stringify([r.host,r.pageId]);
      if(seen.has(key))throw new Error('Wiki manifest revision mismatch');seen.add(key);
      const shown=indexed(d,r,this.presentation);
      const row=this.db.prepare('INSERT INTO docs(url,title,body,crawlDate) VALUES(?,?,?,?)').run(`${d.host}/w/index.php?oldid=${d.version}`,shown.title,shown.body,d.availableAt);
      this.db.prepare('INSERT INTO docs_fts(rowid,title,body) VALUES(?,?,?)').run(row.lastInsertRowid,shown.title,shown.body);
      if(this.presentation)for(const k of aliasKeys(r))this.db.prepare('INSERT OR IGNORE INTO aliases(key,id) VALUES(?,?)').run(k,row.lastInsertRowid);
    }
    }catch(error){this.cache?.close();this.db.close();throw error;}
  }
  frequency(term:string):number{return (this.db.prepare('SELECT doc FROM docs_vocab WHERE term=?').get(term) as {doc:number}|undefined)?.doc??0;}
  private hydrate(row:Record<string,unknown>):RankedDocument{
    if(!this.cache)return row as unknown as RankedDocument;
    const d=verifyMember(this.cache,{host:row.host as string,version:row.version as string,pageId:row.pageId as number,bodySha256:row.bodySha256 as string,availableAt:row.crawlDate as string,cachedAt:row.cachedAt as string},this.snapshotIdentity.manifest.anchor);
    const shown=indexed(d,this.members.get(`${d.host}\n${d.version}`)!,this.presentation);
    if(shown.title!==row.title)throw new Error('Wiki index title mismatch');
    return Object.assign(Object.create(null),{id:row.id,url:row.url,title:shown.title,body:shown.body,crawlDate:d.availableAt,score:row.score}) as RankedDocument;
  }
  searchRaw(expression:string,anchor:string,limit:number):RankedDocument[]{this.assertAnchor(anchor);return this.db.prepare('SELECT d.*,bm25(docs_fts) AS score FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid WHERE docs_fts MATCH ? ORDER BY score,d.url LIMIT ?').all(expression,limit).map(row=>this.hydrate(row));}
  getByUrlBefore(url:string,anchor:string):RankedDocument|null{
    this.assertAnchor(anchor);
    const row=this.db.prepare('SELECT *,0 AS score FROM docs WHERE url=?').get(url);
    if(row)return this.present(this.hydrate(row));
    // With a presentation, an ordinary article address opens the revision pinned for that title.
    const key=this.presentation?wikiUrlKey(url):null;
    const alias=key?this.db.prepare('SELECT d.*,0 AS score FROM aliases a JOIN docs d ON d.id=a.id WHERE a.key=?').get(key):undefined;
    return alias?this.present(this.hydrate(alias)):null;
  }
  /** The document as the model reads it: with a presentation, a snapshot member's wikitext becomes
   * plain text. Other documents, and every document of an original manifest, pass through. */
  present<T extends RankedDocument>(doc:T):T{
    if(!this.presentation)return doc;
    const version=/^(https:\/\/[^/]+)\/w\/index\.php\?oldid=(\d+)$/.exec(doc.url);
    if(!version||!this.members.has(`${version[1]}\n${version[2]}`))return doc;
    return Object.assign(Object.create(null),doc,{body:wikitextToPlain(doc.body)}) as T;
  }

  assertAnchor(anchor:string){if(wikiAnchor(anchor)!==this.snapshotIdentity.manifest.anchor)throw new Error('Wiki snapshot anchor mismatch');}
  close(){this.db.close();this.cache?.close();}
}
