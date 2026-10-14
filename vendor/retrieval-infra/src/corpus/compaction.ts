/** Rewrites a CC-News corpus with encoded article bodies, verifies the rewrite, and records a
 * receipt that lets frozen indexes accept the smaller file.
 *
 * The rewrite keeps every row id and every column except the body's storage form. The
 * full-text index is either copied verbatim from the source ("copy") or left out and rebuilt
 * after the swap ("skip"), which needs about half the temporary disk space.
 */
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, openSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  BODY_CODEC_DEFLATE_DICTIONARY, BodyCodec, createBodyDictionaryTable, decodeBody, dictionarySha256, trainBodyDictionary,
  BODY_DICTIONARY_TABLE,
} from './body-codec.js';
import { capturedDocumentHash, type FrozenIndexMetadata } from './frozen-index.js';

export const CORPUS_COMPACTION_TABLE = 'corpus_compactions';
const PROGRESS_TABLE = 'corpus_compaction_progress';
const FTS_TABLES = ['docs_fts', 'docs_vocab', 'docs_fts_data', 'docs_fts_idx', 'docs_fts_docsize', 'docs_fts_config'];

type FtsMode = 'copy' | 'skip';
interface SourceIdentity { path: string; size: number; mtimeMs: number }
export interface CompactionProgress {
  schema: 'raven.corpus-compaction.v1'; status: 'building' | 'built';
  source: SourceIdentity; dictionarySha256: string; fts: FtsMode | 'rebuilt';
  ftsDefinitions: string[]; lastId: number; documents: number; ftsLastDataId: number;
  rawBodyBytes: number; storedBodyBytes: number; startedAt: string; updatedAt: string;
}

const identityOf = (path: string): SourceIdentity => { const st = statSync(path); return { path, size: st.size, mtimeMs: st.mtimeMs }; };
const readOnlyUri = (path: string) => { const u = pathToFileURL(path); u.search = 'mode=ro'; return u.href; };

/** Samples bodies evenly across the id range and trains a deflate preset dictionary. */
export function trainCorpusDictionary(sourcePath: string, samples = 20000): Buffer {
  const db = new DatabaseSync(resolve(sourcePath), { readOnly: true });
  try {
    const max = (db.prepare('SELECT max(id) AS id FROM docs').get() as { id: number | null }).id ?? 0;
    if (!max) throw new Error('source corpus is empty');
    const step = Math.max(1, Math.floor(max / samples));
    const get = db.prepare('SELECT body FROM docs WHERE id >= ? ORDER BY id LIMIT 1');
    const codec = BodyCodec.load(db);
    const texts: string[] = [];
    for (let id = 1; id <= max && texts.length < samples; id += step) {
      const row = get.get(id) as { body: unknown } | undefined;
      if (row) texts.push(decodeBody(row.body, codec));
    }
    return trainBodyDictionary(texts);
  } finally { db.close(); }
}

/** Builds (or resumes building) the compacted copy. The source must not change meanwhile. */
export async function compactCorpus(sourcePath: string, targetPath: string, dictionary: Buffer, opts: {
  fts?: FtsMode; batchSize?: number; level?: number; minimumFreeBytes?: number; maxBatches?: number;
  onProgress?: (p: CompactionProgress) => void; signal?: AbortSignal;
} = {}): Promise<CompactionProgress> {
  sourcePath = resolve(sourcePath); targetPath = resolve(targetPath);
  if (sourcePath === targetPath) throw new Error('source and compacted corpus must be distinct');
  const fts = opts.fts ?? 'copy', batch = opts.batchSize ?? 5000, minFree = opts.minimumFreeBytes ?? 12 * 1024 ** 3;
  if (!Number.isInteger(batch) || batch < 1) throw new Error('positive batch size required');
  const lockPath = targetPath + '.compact-lock';
  const lock = openSync(lockPath, 'wx', 0o664);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), targetPath }) + '\n'); closeSync(lock);
  let source: DatabaseSync | undefined, target: DatabaseSync | undefined;
  try {
    const identity = identityOf(sourcePath);
    source = new DatabaseSync(sourcePath, { readOnly: true });
    if (BodyCodec.load(source)) throw new Error('source corpus is already compacted');
    const existed = existsSync(targetPath);
    target = new DatabaseSync(targetPath);
    if (existed && !target.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(PROGRESS_TABLE))
      throw new Error('destination exists and is not a resumable compaction');
    const sha = dictionarySha256(dictionary);
    const schemaRows = source.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL").all() as
      { type: string; name: string; tbl_name: string; sql: string }[];
    const isFts = (name: string) => FTS_TABLES.includes(name);
    const tables = schemaRows.filter(r => r.type === 'table' && !isFts(r.name) && !r.name.startsWith('sqlite_'));
    const indexes = schemaRows.filter(r => r.type === 'index' && !isFts(r.tbl_name));
    const ftsDefinitions = ['docs_fts', 'docs_vocab'].map(n => schemaRows.find(r => r.name === n)?.sql).filter((s): s is string => !!s);
    let progress: CompactionProgress;
    const save = () => target!.prepare(`INSERT OR REPLACE INTO ${PROGRESS_TABLE}(id, json) VALUES (1, ?)`).run(JSON.stringify(progress));
    if (!existed) {
      target.exec('PRAGMA page_size=4096; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
      target.exec('BEGIN');
      for (const t of tables) target.exec(t.sql);
      createBodyDictionaryTable(target);
      target.prepare(`INSERT INTO ${BODY_DICTIONARY_TABLE}(id, codec, sha256, dictionary, created_at) VALUES (1, ?, ?, ?, ?)`)
        .run(BODY_CODEC_DEFLATE_DICTIONARY, sha, dictionary, new Date().toISOString());
      target.exec(`CREATE TABLE ${PROGRESS_TABLE} (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL)`);
      const now = new Date().toISOString();
      progress = { schema: 'raven.corpus-compaction.v1', status: 'building', source: identity, dictionarySha256: sha, fts,
        ftsDefinitions, lastId: 0, documents: 0, ftsLastDataId: -1, rawBodyBytes: 0, storedBodyBytes: 0, startedAt: now, updatedAt: now };
      save();
      target.exec('COMMIT');
    } else {
      target.exec('PRAGMA synchronous=NORMAL;');
      progress = JSON.parse((target.prepare(`SELECT json FROM ${PROGRESS_TABLE} WHERE id=1`).get() as { json: string }).json);
      if (progress.schema !== 'raven.corpus-compaction.v1' || JSON.stringify(progress.source) !== JSON.stringify(identity)
        || progress.dictionarySha256 !== sha || progress.fts !== fts)
        throw new Error('source, dictionary or full-text mode changed; refusing to mix compactions');
      if (progress.status === 'built') return progress;
      target.exec('PRAGMA journal_mode=WAL;');
    }
    target.prepare('ATTACH DATABASE ? AS src').run(readOnlyUri(sourcePath));
    const codec = BodyCodec.load(target, 'main', opts.level)!;
    const guard = () => {
      if (opts.signal?.aborted) throw new Error('compaction interrupted; committed checkpoint can be resumed');
      const fs = statfsSync(dirname(targetPath));
      if (fs.bavail * fs.bsize < minFree) throw new Error('insufficient disk reserve; checkpoint kept for resume');
      const now = statSync(sourcePath);
      if (now.size !== identity.size || now.mtimeMs !== identity.mtimeMs) throw new Error('source changed during compaction');
    };
    const commit = () => {
      progress.updatedAt = new Date().toISOString(); save(); target!.exec('COMMIT');
      target!.exec('PRAGMA wal_checkpoint(TRUNCATE)'); opts.onProgress?.({ ...progress });
    };

    // Small tables (shard ledger and similar) are copied whole in the first batch.
    if (progress.lastId === 0 && progress.documents === 0) {
      target.exec('BEGIN IMMEDIATE');
      for (const t of tables) if (t.name !== 'docs') target.exec(`INSERT INTO main."${t.name}" SELECT * FROM src."${t.name}"`);
      commit();
    }
    const read = source.prepare('SELECT id, url, title, body, crawl_date, crawl_ms, wire, source FROM docs WHERE id > ? ORDER BY id LIMIT ?');
    const insert = target.prepare('INSERT INTO main.docs (id, url, title, body, crawl_date, crawl_ms, wire, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    let batches = 0;
    for (;;) {
      guard();
      let added = 0;
      target.exec('BEGIN IMMEDIATE');
      try {
        for (const raw of read.iterate(progress.lastId, batch)) {
          const d = raw as { id: number; url: string; title: string; body: unknown; crawl_date: string; crawl_ms: number; wire: string | null; source: string };
          if (typeof d.body !== 'string') throw new Error(`source body ${d.id} is not text`);
          const encoded = codec.encode(d.body);
          if (codec.decode(encoded) !== d.body) throw new Error(`body ${d.id} does not round-trip`);
          insert.run(d.id, d.url, d.title, encoded, d.crawl_date, d.crawl_ms, d.wire, d.source);
          progress.lastId = d.id; progress.documents++; added++;
          progress.rawBodyBytes += Buffer.byteLength(d.body, 'utf8'); progress.storedBodyBytes += encoded.length;
        }
        commit();
      } catch (e) { target.exec('ROLLBACK'); throw e; }
      batches++;
      if (added === 0) break;
      if (opts.maxBatches && batches >= opts.maxBatches) return progress;
      await new Promise<void>(r => setImmediate(r));
    }

    if (fts === 'copy') {
      if (!target.prepare("SELECT 1 FROM sqlite_master WHERE name='docs_fts'").get()) {
        target.exec('BEGIN IMMEDIATE');
        for (const sql of ftsDefinitions) target.exec(sql);
        // The shadow tables are replaced by the source's exact rows below.
        for (const t of ['docs_fts_data', 'docs_fts_idx', 'docs_fts_docsize', 'docs_fts_config']) target.exec(`DELETE FROM main.${t}`);
        target.exec('INSERT INTO main.docs_fts_idx SELECT * FROM src.docs_fts_idx');
        target.exec('INSERT INTO main.docs_fts_config SELECT * FROM src.docs_fts_config');
        target.exec('INSERT INTO main.docs_fts_docsize SELECT * FROM src.docs_fts_docsize');
        commit();
      }
      const ftsRead = source.prepare('SELECT id, block FROM docs_fts_data WHERE id > ? ORDER BY id LIMIT ?');
      const ftsInsert = target.prepare('INSERT INTO main.docs_fts_data (id, block) VALUES (?, ?)');
      for (;;) {
        guard();
        let added = 0;
        target.exec('BEGIN IMMEDIATE');
        try {
          for (const raw of ftsRead.iterate(progress.ftsLastDataId, batch * 4)) {
            const r = raw as { id: number; block: Uint8Array };
            ftsInsert.run(r.id, r.block); progress.ftsLastDataId = r.id; added++;
          }
          commit();
        } catch (e) { target.exec('ROLLBACK'); throw e; }
        if (added === 0) break;
        await new Promise<void>(r => setImmediate(r));
      }
    }
    target.exec('BEGIN IMMEDIATE');
    for (const i of indexes) target.exec(i.sql.replace(/^CREATE (UNIQUE )?INDEX /i, m => m + 'IF NOT EXISTS '));
    progress.status = 'built';
    commit();
    // Readers open the corpus read-only from many processes; keep the original rollback-journal mode
    // so they do not need to create WAL side files in the shared directory.
    target.exec('PRAGMA journal_mode=DELETE');
    return progress;
  } finally {
    target?.close(); source?.close();
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}

export interface CompactionVerification {
  documents: number; maxId: number; rawBodyBytes: number; storedBodyBytes: number;
  tables: Record<string, string>; fts: Record<string, string> | 'not-copied';
  frozenIndexes: { path: string; anchor: string; documents: number }[]; checkedAt: string;
}

const tableDigest = (db: DatabaseSync, sql: string) => {
  const h = createHash('sha256'); let n = 0;
  for (const row of db.prepare(sql).iterate()) {
    h.update(JSON.stringify(Object.values(row as Record<string, unknown>).map(v => v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v)));
    n++;
  }
  return `${n}:${h.digest('hex')}`;
};

/** Compares every row of the compacted copy with the source and every frozen index hash with the
 * decoded copy, then records the receipt that frozen readers require before using a smaller file. */
export function verifyCompaction(sourcePath: string, targetPath: string, opts: {
  frozenIndexes?: string[]; batchSize?: number; onProgress?: (checkedId: number) => void; writeReceipt?: boolean;
} = {}): CompactionVerification {
  sourcePath = resolve(sourcePath); targetPath = resolve(targetPath);
  const batch = opts.batchSize ?? 20000;
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const target = new DatabaseSync(targetPath, { readOnly: true });
  let result: CompactionVerification;
  try {
    const progress = JSON.parse((target.prepare(`SELECT json FROM ${PROGRESS_TABLE} WHERE id=1`).get() as { json: string }).json) as CompactionProgress;
    if (progress.status !== 'built') throw new Error('compaction has not finished');
    const codec = BodyCodec.load(target);
    if (!codec) throw new Error('compacted corpus has no body dictionary');
    const columns = 'id, url, title, body, crawl_date, crawl_ms, wire, source';
    const a = source.prepare(`SELECT ${columns} FROM docs WHERE id > ? ORDER BY id LIMIT ?`);
    const b = target.prepare(`SELECT ${columns} FROM docs WHERE id > ? ORDER BY id LIMIT ?`);
    let last = 0, documents = 0, raw = 0, stored = 0;
    for (;;) {
      const left = a.all(last, batch) as Record<string, unknown>[], right = b.all(last, batch) as Record<string, unknown>[];
      if (left.length !== right.length) throw new Error(`row count differs after id ${last}`);
      if (!left.length) break;
      for (let i = 0; i < left.length; i++) {
        const s = left[i]!, t = right[i]!;
        for (const c of ['id', 'url', 'title', 'crawl_date', 'crawl_ms', 'wire', 'source'])
          if (s[c] !== t[c]) throw new Error(`column ${c} differs for id ${s.id}`);
        const body = decodeBody(t.body, codec);
        if (body !== s.body) throw new Error(`body differs for id ${s.id}`);
        raw += Buffer.byteLength(body, 'utf8'); stored += (t.body as Uint8Array).length; documents++;
      }
      last = left.at(-1)!.id as number;
      opts.onProgress?.(last);
    }
    const names = (source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql IS NOT NULL").all() as { name: string }[])
      .map(r => r.name).filter(n => n !== 'docs' && !FTS_TABLES.includes(n) && !n.startsWith('sqlite_'));
    const tables: Record<string, string> = {};
    for (const n of names) {
      const order = `SELECT * FROM "${n}" ORDER BY 1`;
      const left = tableDigest(source, order), right = tableDigest(target, order);
      if (left !== right) throw new Error(`table ${n} differs`);
      tables[n] = right;
    }
    let fts: CompactionVerification['fts'] = 'not-copied';
    if (progress.fts === 'copy') {
      fts = {};
      for (const [n, order] of [['docs_fts_data', 'id'], ['docs_fts_idx', 'segid, term'], ['docs_fts_docsize', 'id'], ['docs_fts_config', 'k']] as const) {
        const sql = `SELECT * FROM ${n} ORDER BY ${order}`;
        const left = tableDigest(source, sql), right = tableDigest(target, sql);
        if (left !== right) throw new Error(`full-text table ${n} differs`);
        fts[n] = right;
      }
    }
    const frozenIndexes: CompactionVerification['frozenIndexes'] = [];
    for (const path of opts.frozenIndexes ?? []) {
      const index = new DatabaseSync(resolve(path), { readOnly: true });
      try {
        const meta = JSON.parse((index.prepare('SELECT json FROM frozen_index_metadata WHERE id=1').get() as { json: string }).json) as FrozenIndexMetadata;
        if (meta.status !== 'complete') throw new Error(`frozen index ${path} is incomplete`);
        const get = target.prepare('SELECT url, title, body, crawl_date FROM docs WHERE id = ?');
        let n = 0;
        for (const raw of index.prepare('SELECT id, body_sha256 FROM frozen_documents ORDER BY id').iterate()) {
          const f = raw as { id: number; body_sha256: Uint8Array };
          const d = get.get(f.id) as { url: string; title: string; body: unknown; crawl_date: string } | undefined;
          if (!d || !capturedDocumentHash(d.url, d.title, decodeBody(d.body, codec), d.crawl_date).equals(f.body_sha256))
            throw new Error(`frozen document ${f.id} of ${path} does not match the compacted copy`);
          n++;
        }
        if (n !== meta.documents) throw new Error(`frozen index ${path} lists ${n} documents, metadata says ${meta.documents}`);
        frozenIndexes.push({ path: resolve(path), anchor: meta.anchor, documents: n });
      } finally { index.close(); }
    }
    result = { documents, maxId: last, rawBodyBytes: raw, storedBodyBytes: stored, tables, fts, frozenIndexes, checkedAt: new Date().toISOString() };
  } finally { target.close(); source.close(); }
  if (opts.writeReceipt !== false) {
    const db = new DatabaseSync(targetPath);
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS ${CORPUS_COMPACTION_TABLE} (id INTEGER PRIMARY KEY, completed_at TEXT NOT NULL,
        max_id INTEGER NOT NULL, documents INTEGER NOT NULL, receipt TEXT NOT NULL)`);
      db.prepare(`INSERT INTO ${CORPUS_COMPACTION_TABLE}(completed_at, max_id, documents, receipt) VALUES (?, ?, ?, ?)`)
        .run(result.checkedAt, result.maxId, result.documents, JSON.stringify({ source: identityOf(sourcePath), ...result }));
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
  }
  return result;
}

/** Builds the full-text index of a copy compacted with fts "skip", from the decoded bodies. */
export async function rebuildCompactedFts(targetPath: string, opts: { batchSize?: number; onProgress?: (lastId: number) => void } = {}) {
  const db = new DatabaseSync(resolve(targetPath));
  // The swapped-in corpus uses the rollback journal and experiments keep reading it, so each
  // commit waits for their short read locks instead of failing with "database is locked".
  db.exec('PRAGMA busy_timeout=60000');
  try {
    const progress = JSON.parse((db.prepare(`SELECT json FROM ${PROGRESS_TABLE} WHERE id=1`).get() as { json: string }).json) as CompactionProgress;
    if (progress.status !== 'built' || progress.fts !== 'skip') throw new Error('only a finished compaction built without its full-text index can be rebuilt');
    const codec = BodyCodec.load(db)!;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='docs_fts'").get()) for (const sql of progress.ftsDefinitions) db.exec(sql);
    const done = (db.prepare('SELECT max(id) AS id FROM docs_fts_docsize').get() as { id: number | null }).id ?? 0;
    const read = db.prepare('SELECT id, title, body FROM main.docs WHERE id > ? ORDER BY id LIMIT ?');
    const insert = db.prepare('INSERT INTO docs_fts (rowid, title, body) VALUES (?, ?, ?)');
    let last = done;
    for (;;) {
      const rows = read.all(last, opts.batchSize ?? 5000) as { id: number; title: string; body: unknown }[];
      if (!rows.length) break;
      db.exec('BEGIN IMMEDIATE');
      try { for (const r of rows) insert.run(r.id, r.title, decodeBody(r.body, codec)); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      last = rows.at(-1)!.id; db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); opts.onProgress?.(last);
      await new Promise<void>(r => setImmediate(r));
    }
    const docs = (db.prepare('SELECT count(*) AS n FROM main.docs').get() as { n: number }).n;
    const indexed = (db.prepare('SELECT count(*) AS n FROM docs_fts_docsize').get() as { n: number }).n;
    if (docs !== indexed) throw new Error(`full-text index covers ${indexed} of ${docs} documents`);
    progress.fts = 'rebuilt'; progress.updatedAt = new Date().toISOString();
    db.prepare(`UPDATE ${PROGRESS_TABLE} SET json=? WHERE id=1`).run(JSON.stringify(progress));
    return progress;
  } finally { db.close(); }
}
