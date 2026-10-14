import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorpusStore } from './store.js';
import { buildFrozenIndex } from './frozen-index.js';
import { corpusRetrievalIdentity } from './retrieval-identity.js';
import { FrozenWorkerPool } from './frozen-worker-pool.js';
import { DatabaseSync } from 'node:sqlite';

test('ordinary and isolated retrieval cannot reuse one corpus treatment identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retrieval-identity-'));
  try {
    const source = join(dir, 'source.db'), historical = join(dir, 'historical.db');
    const s = new CorpusStore(source, 'or', 'write');
    s.ingest([{ url: 'https://test/a', title: 'Historical', body: 'Historical fact', crawlDate: '2026-01-01T00:00:00Z' }]);
    s.close();
    const sourceIdentity = corpusRetrievalIdentity(source);
    await buildFrozenIndex(source, historical, '2026-03-01T00:00:00Z', { minimumFreeBytes: 0 });
    const beforeStore=new CorpusStore(historical);
    const before=beforeStore.search('Historical','2026-03-01T00:00:00Z',5);beforeStore.close();
    const identity = corpusRetrievalIdentity(historical);
    assert.equal(identity.kind, 'historical-fts-index');
    assert.equal(identity.anchor, '2026-03-01T00:00:00.000Z');
    assert.notDeepEqual(sourceIdentity, identity);
    assert.deepEqual(identity, corpusRetrievalIdentity(historical));
    const alias = join(dir, 'alias.db'); symlinkSync(historical, alias);
    assert.deepEqual(identity, corpusRetrievalIdentity(alias));
    // The shared corpus is append-only. Captures at or after the anchor can never enter this
    // index, so ingesting them (which changes the file's size and mtime) keeps the treatment.
    const later = new CorpusStore(source, 'or', 'write');
    later.ingest([{ url: 'https://test/b', title: 'Later', body: 'Captured after the anchor', crawlDate: '2026-09-10T00:00:00Z' }]);
    later.close();
    assert.deepEqual(identity, corpusRetrievalIdentity(historical));
    utimesSync(source, new Date('2027-01-01'), new Date('2027-01-01'));
    assert.deepEqual(identity, corpusRetrievalIdentity(historical));
    assert.notDeepEqual(sourceIdentity, corpusRetrievalIdentity(source));
    const afterStore=new CorpusStore(historical);
    assert.deepEqual(afterStore.search('Historical','2026-03-01T00:00:00Z',5),before);afterStore.close();
    const pool=new FrozenWorkerPool({corpusPath:historical,workers:2});
    try { assert.equal((await pool.getByUrlBefore('https://test/a','2026-03-01T00:00:00Z'))?.body,'Historical fact'); } finally {pool.close();}
    // A pre-anchor row appearing behind the build's last id would change what the index should
    // contain, so the stale index is refused.
    const stale = new CorpusStore(source, 'or', 'write');
    stale.ingest([{ url: 'https://test/c', title: 'Backfilled', body: 'Captured before the anchor', crawlDate: '2026-02-01T00:00:00Z' }]);
    stale.close();
    assert.throws(() => corpusRetrievalIdentity(historical), /pre-anchor documents were added/);
    assert.throws(() => new CorpusStore(historical), /pre-anchor documents were added/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unfinished index has no valid experiment treatment identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retrieval-identity-'));
  try {
    const source = join(dir, 'source.db'), historical = join(dir, 'historical.db');
    const s = new CorpusStore(source, 'or', 'write');
    s.ingest([{ url: 'https://test/a', title: 'A', body: 'A', crawlDate: '2026-01-01T00:00:00Z' }]); s.close();
    await buildFrozenIndex(source, historical, '2026-03-01T00:00:00Z', { minimumFreeBytes: 0, maxBatches: 1 });
    assert.throws(() => corpusRetrievalIdentity(historical), /incomplete/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a source that lost indexed pre-anchor documents is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retrieval-identity-'));
  try {
    const source = join(dir, 'source.db'), historical = join(dir, 'historical.db');
    const s = new CorpusStore(source, 'or', 'write');
    s.ingest([
      { url: 'https://test/a', title: 'A', body: 'A', crawlDate: '2026-01-01T00:00:00Z' },
      { url: 'https://test/b', title: 'B', body: 'B', crawlDate: '2026-01-02T00:00:00Z' },
    ]);
    s.close();
    await buildFrozenIndex(source, historical, '2026-03-01T00:00:00Z', { minimumFreeBytes: 0 });
    const identity = corpusRetrievalIdentity(historical);
    assert.equal(identity.documents, 2);
    const db = new DatabaseSync(source);
    db.exec("DELETE FROM docs WHERE url='https://test/b'; DELETE FROM docs_fts WHERE rowid NOT IN (SELECT id FROM docs); VACUUM");
    db.close();
    assert.throws(() => corpusRetrievalIdentity(historical), /source shrank|pre-anchor documents remain/);
    assert.throws(() => new CorpusStore(historical), /source shrank|pre-anchor documents remain/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
