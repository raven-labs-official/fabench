import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CorpusStore } from './store.js';
import { buildFrozenIndex, type FrozenIndexMetadata } from './frozen-index.js';
import { BodyCodec, decodeBody, dictionarySha256, trainBodyDictionary } from './body-codec.js';
import { compactCorpus, rebuildCompactedFts, verifyCompaction } from './compaction.js';
import { assertSourceOnlyGrewAfterAnchor } from './retrieval-identity.js';
import { queryFrozen } from './frozen-query.js';

const anchor = '2026-03-01T00:00:00.000Z';
const boilerplate = 'Subscribe to our newsletter for the latest updates. All rights reserved. Advertisement. ';
const body = (i: number) => `${boilerplate}Report ${i}: alpha beta ${i % 3 ? 'gamma' : 'delta'} central bank rates – naïve café ${'x'.repeat(i % 7)}. ${boilerplate}`;

function seed(path: string, count = 40) {
  const s = new CorpusStore(path, 'or', 'write');
  s.ingest(Array.from({ length: count }, (_, i) => ({
    url: `https://test/${i}`, title: `Title ${i} alpha`, body: body(i),
    crawlDate: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 3 * 86_400_000).toISOString(),
  })));
  s.close();
  // Ordinary read-only opening refuses files under 1 MB; other tables must survive compaction too.
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE padding (x BLOB); INSERT INTO padding VALUES (randomblob(1100000));'); db.close();
}
const dictionary = () => trainBodyDictionary(Array.from({ length: 40 }, (_, i) => body(i)), 4096);
const withDir = async (fn: (dir: string) => Promise<void> | void) => {
  const dir = mkdtempSync(join(tmpdir(), 'compaction-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('encoded bodies round-trip exactly and plain text passes through', () => {
  const dict = dictionary();
  const codec = new BodyCodec([{ id: 1, codec: 1, sha256: dictionarySha256(dict), dictionary: dict }]);
  for (const text of [body(5), '', 'émoji 😀 and 中文', 'a'.repeat(100_000)]) assert.equal(codec.decode(codec.encode(text)), text);
  assert.equal(decodeBody('plain', null), 'plain');
  assert.throws(() => decodeBody(codec.encode('x'), null), /missing dictionary/);
  assert.throws(() => decodeBody(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), codec), /unknown encoding/);
  assert.throws(() => new BodyCodec([{ id: 1, codec: 1, sha256: 'wrong', dictionary: dict }]), /recorded hash/);
});

test('compaction keeps frozen search results identical and records a receipt that allows a smaller source', async () => withDir(async dir => {
  const src = join(dir, 'source.db'), dst = join(dir, 'compacted.db'), index = join(dir, 'index.db');
  seed(src);
  const meta = await buildFrozenIndex(src, index, anchor, { minimumFreeBytes: 0 });
  const first = await compactCorpus(src, dst, dictionary(), { batchSize: 7, maxBatches: 2, minimumFreeBytes: 0 });
  assert.equal(first.status, 'building');
  const built = await compactCorpus(src, dst, dictionary(), { batchSize: 7, minimumFreeBytes: 0 });
  assert.equal(built.status, 'built'); assert.equal(built.documents, 40);
  assert.ok(built.storedBodyBytes < built.rawBodyBytes);

  const raw = new DatabaseSync(dst, { readOnly: true });
  try { assert.ok((raw.prepare('SELECT body FROM docs WHERE id=1').get() as { body: unknown }).body instanceof Uint8Array); }
  finally { raw.close(); }

  // A smaller source is refused until verification has written the receipt.
  const bigger: FrozenIndexMetadata = { ...meta, source: { ...meta.source, size: Number.MAX_SAFE_INTEGER } };
  assert.throws(() => assertSourceOnlyGrewAfterAnchor(bigger, statSync(dst).size, dst), /source shrank/);
  const report = verifyCompaction(src, dst, { frozenIndexes: [index] });
  assert.equal(report.documents, 40); assert.equal(report.frozenIndexes[0]!.documents, meta.documents);
  assert.ok(report.fts !== 'not-copied' && report.fts.docs_fts_data);
  assertSourceOnlyGrewAfterAnchor(bigger, statSync(dst).size, dst);

  const original = new CorpusStore(index, 'or'), rewritten = new CorpusStore(index, 'or', 'auto', { frozenSourcePath: dst });
  try {
    for (const q of ['alpha beta', 'gamma', 'central bank rates', 'delta']) {
      assert.deepEqual(rewritten.search(q, anchor, 10), original.search(q, anchor, 10));
      assert.deepEqual(rewritten.searchRaw(q.split(' ').join(' OR '), anchor, 10), original.searchRaw(q.split(' ').join(' OR '), anchor, 10));
      assert.deepEqual(queryFrozen(rewritten, undefined, q, 5, anchor).hits, queryFrozen(original, undefined, q, 5, anchor).hits);
    }
    assert.equal(rewritten.getByUrlBefore('https://test/3', anchor)?.body, body(3));
  } finally { original.close(); rewritten.close(); }

  // Ordinary readers see decoded text; writers append encoded rows that stay searchable.
  const plain = new CorpusStore(src, 'or'), packed = new CorpusStore(dst, 'or');
  try { assert.deepEqual(packed.search('alpha', '2026-12-31T00:00:00Z', 50), plain.search('alpha', '2026-12-31T00:00:00Z', 50)); }
  finally { plain.close(); packed.close(); }
  const writer = new CorpusStore(dst, 'or', 'write');
  writer.ingest([{ url: 'https://test/new', title: 'Fresh zeta', body: `zeta ${boilerplate}`, crawlDate: '2026-11-01T00:00:00Z' }]);
  writer.close();
  const check = new DatabaseSync(dst, { readOnly: true });
  try { assert.ok((check.prepare("SELECT body FROM docs WHERE url='https://test/new'").get() as { body: unknown }).body instanceof Uint8Array); }
  finally { check.close(); }
  const reader = new CorpusStore(dst, 'or');
  try { assert.equal(reader.search('zeta', '2026-12-31T00:00:00Z', 5)[0]?.body, `zeta ${boilerplate}`); } finally { reader.close(); }
}));

test('a tampered encoded body fails the frozen read instead of changing evidence', async () => withDir(async dir => {
  const src = join(dir, 'source.db'), dst = join(dir, 'compacted.db'), index = join(dir, 'index.db');
  seed(src);
  await buildFrozenIndex(src, index, anchor, { minimumFreeBytes: 0 });
  await compactCorpus(src, dst, dictionary(), { minimumFreeBytes: 0 });
  verifyCompaction(src, dst, { frozenIndexes: [index] });
  const db = new DatabaseSync(dst), codec = BodyCodec.load(db)!;
  db.prepare('UPDATE docs SET body=? WHERE id=4').run(codec.encode('a subsequently changed future outcome')); db.close();
  const store = new CorpusStore(index, 'or', 'auto', { frozenSourcePath: dst });
  try { assert.throws(() => store.getByUrlBefore('https://test/3', anchor), /differs from captured bytes/); } finally { store.close(); }
}));

test('a compaction without its full-text index can rebuild it from decoded bodies', async () => withDir(async dir => {
  const src = join(dir, 'source.db'), dst = join(dir, 'compacted.db');
  seed(src);
  await compactCorpus(src, dst, dictionary(), { fts: 'skip', minimumFreeBytes: 0 });
  const report = verifyCompaction(src, dst);
  assert.equal(report.fts, 'not-copied');
  // A reader holding its lock while the rebuild commits only delays the rebuild.
  const reader = spawn(process.execPath, ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(dst)}, { readOnly: true });
    db.exec('BEGIN'); db.prepare('SELECT count(*) FROM docs').get(); console.log('reading');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); db.exec('COMMIT'); db.close();`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const readerExit = new Promise(resolve => reader.on('exit', resolve));
  await new Promise<void>(resolve => reader.stdout.once('data', () => resolve()));
  const rebuilt = await rebuildCompactedFts(dst, { batchSize: 9 });
  assert.equal(rebuilt.fts, 'rebuilt');
  assert.equal(await readerExit, 0);
  const plain = new CorpusStore(src, 'or'), packed = new CorpusStore(dst, 'or');
  try {
    for (const q of ['alpha', 'gamma bank', 'delta']) {
      const urls = (s: CorpusStore) => s.search(q, '2026-12-31T00:00:00Z', 50).map(h => h.url).sort();
      assert.deepEqual(urls(packed), urls(plain));
    }
  } finally { plain.close(); packed.close(); }
}));

test('a frozen index built from a compacted source has the same captured hashes', async () => withDir(async dir => {
  const src = join(dir, 'source.db'), dst = join(dir, 'compacted.db');
  seed(src);
  await compactCorpus(src, dst, dictionary(), { minimumFreeBytes: 0 });
  await buildFrozenIndex(src, join(dir, 'a.db'), anchor, { minimumFreeBytes: 0 });
  await buildFrozenIndex(dst, join(dir, 'b.db'), anchor, { minimumFreeBytes: 0 });
  const hashes = (p: string) => { const db = new DatabaseSync(p, { readOnly: true }); try { return db.prepare('SELECT id, hex(body_sha256) AS h FROM frozen_documents ORDER BY id').all(); } finally { db.close(); } };
  assert.deepEqual(hashes(join(dir, 'b.db')), hashes(join(dir, 'a.db')));
  await assert.rejects(compactCorpus(dst, join(dir, 'again.db'), dictionary(), { minimumFreeBytes: 0 }), /already compacted/);
}));

test('a compaction refuses unsafe resumes, a short disk reserve and an unverified copy', async () => withDir(async dir => {
  const src = join(dir, 'source.db'), dst = join(dir, 'compacted.db');
  seed(src);
  await assert.rejects(compactCorpus(src, dst + '.x', dictionary(), { minimumFreeBytes: Number.MAX_SAFE_INTEGER }), /disk reserve/);
  await compactCorpus(src, dst, dictionary(), { batchSize: 5, maxBatches: 2, minimumFreeBytes: 0 });
  await assert.rejects(compactCorpus(src, dst, trainBodyDictionary([body(1), body(2), body(3), 'other text '.repeat(50)], 2048), { minimumFreeBytes: 0 }), /refusing to mix/);
  assert.throws(() => verifyCompaction(src, dst), /has not finished/);
  const mutator = new DatabaseSync(src);
  mutator.prepare('UPDATE docs SET title=? WHERE id=40').run('changed later'); mutator.close();
  await assert.rejects(compactCorpus(src, dst, dictionary(), { minimumFreeBytes: 0 }), /refusing to mix/);
}));

test('verification catches a rewritten row and the finished copy uses the rollback journal', async () => withDir(async dir => {
  const src = join(dir, 'source.db'), dst = join(dir, 'compacted.db');
  seed(src);
  await compactCorpus(src, dst, dictionary(), { minimumFreeBytes: 0 });
  const db = new DatabaseSync(dst);
  try {
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete');
    const codec = BodyCodec.load(db)!;
    db.prepare('UPDATE docs SET body=? WHERE id=7').run(codec.encode('different text'));
  } finally { db.close(); }
  assert.throws(() => verifyCompaction(src, dst), /body differs for id 7/);
}));
