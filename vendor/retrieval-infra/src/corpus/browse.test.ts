import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CorpusStore } from './store.js';
import { buildFrozenIndex } from './frozen-index.js';

const anchor = '2026-03-01T00:00:00Z';

test('browse reaches a complete article after more than twenty matches, preserving capture versions and boundaries', () => {
  const store = new CorpusStore();
  try {
    const body = 'Acme coffee complete earnings transcript. ' + 'Management question and answer. '.repeat(2500);
    store.ingest([
      { url: 'https://example.test/call', title: 'Complete call', body, crawlDate: '2026-01-29T15:13:24Z' },
      ...Array.from({ length: 266 }, (_, i) => ({
        url: `https://example.test/decoy-${i}`, title: `Acme coffee market item ${i}`,
        body: 'Acme coffee navigation mentions with little useful content.', crawlDate: '2026-02-15T12:00:00Z',
      })),
      { url: 'https://example.test/call', title: 'Short later copy', body: 'Acme coffee call excerpt.', crawlDate: '2026-02-25T00:00:00Z' },
      { url: 'https://example.test/start', title: 'Acme coffee', body: 'At requested start.', crawlDate: '2026-01-01T00:00:00Z' },
      { url: 'https://example.test/old', title: 'Acme coffee', body: 'Too old.', crawlDate: '2025-12-31T23:59:59Z' },
      { url: 'https://example.test/anchor', title: 'Acme coffee', body: 'Exact anchor.', crawlDate: anchor },
      { url: 'https://example.test/future', title: 'Acme coffee complete call', body: 'Future release.', crawlDate: '2026-03-01T00:00:00.001Z' },
    ]);
    const options = { entity: 'Acme coffee', since: '2026-01-01', until: '2026-12-31', limit: 10 };
    const first = store.browse(options, anchor);
    assert.equal(first.results.length, 10);
    assert.equal(first.results[0].url, 'https://example.test/anchor');
    assert.equal(first.query.until, '2026-03-01T00:00:00.000Z');
    assert.ok(first.nextCursor);
    const all = [...first.results];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = store.browse({ ...options, cursor }, anchor);
      assert.ok(page.results.length <= 10);
      all.push(...page.results);
      cursor = page.nextCursor;
    }
    assert.equal(all.length, 270);
    assert.equal(new Set(all.map(row => row.capturedId)).size, all.length, 'no repeated or skipped captures across tied timestamps');
    assert.ok(all.findIndex(row => row.body === body) > 20, 'complete target remains reachable beyond the first two pages');
    assert.equal(all.filter(row => row.url === 'https://example.test/call').length, 2, 'both captured versions remain inspectable');
    assert.equal(all.at(-1)?.url, 'https://example.test/start');
    assert.ok(all.every(row => row.score === 0 && Date.parse(row.crawlDate) <= Date.parse(anchor)));
  } finally { store.close(); }
});

test('browse keeps all literal entity terms, Unicode names, stopwords and initials; caller FTS operators are inert', () => {
  const store = new CorpusStore();
  try {
    for (const [i, text] of ['The Who live', 'Who live', 'Pedro Sánchez Türkiye', 'Pedro unrelated', 'A B company', 'B company', '北京大学 research', 'Acme OR missing'].entries()) {
      store.ingest([{ url: `https://example.test/${i}`, title: text, body: text, crawlDate: '2026-02-01T00:00:00Z' }]);
    }
    assert.equal(store.browse({ entity: 'The Who' }, anchor).results.length, 1);
    assert.equal(store.browse({ entity: 'Pedro Sa\u0301nchez Türkiye' }, anchor).results.length, 1);
    assert.equal(store.browse({ entity: 'A B' }, anchor).results.length, 1);
    assert.equal(store.browse({ entity: '北京大学' }, anchor).results.length, 1);
    assert.equal(store.browse({ entity: '"Acme" OR "missing"' }, anchor).results.length, 1, 'OR is a required literal token, not query syntax');
    assert.equal(store.browse({ entity: 'Pedro UnknownIdentifier' }, anchor).results.length, 0, 'missing term never relaxes to a broad entity');
    assert.throws(() => store.browse({ entity: '"*():!!!' }, anchor), /entity must contain/);
  } finally { store.close(); }
});

test('browse cursor cannot be reused with another entity, range, or anchor; dates and limits are validated', () => {
  const store = new CorpusStore();
  try {
    for (let i = 0; i < 3; i++) store.ingest([{ url: `https://example.test/${i}`, title: 'Acme', body: 'Acme', crawlDate: '2026-02-01T00:00:00Z' }]);
    const { nextCursor } = store.browse({ entity: 'Acme', limit: 1 }, anchor);
    assert.ok(nextCursor);
    assert.equal(store.browse({ entity: 'ACME', cursor: nextCursor, limit: 2 }, anchor).results.length, 2, 'case and page-size changes preserve scope');
    assert.throws(() => store.browse({ entity: 'Other', cursor: nextCursor }, anchor), /invalid browse cursor/);
    assert.throws(() => store.browse({ entity: 'Acme', since: '2026-01-01', cursor: nextCursor }, anchor), /invalid browse cursor/);
    assert.throws(() => store.browse({ entity: 'Acme', cursor: nextCursor }, '2026-03-02T00:00:00Z'), /invalid browse cursor/);
    assert.throws(() => store.browse({ entity: 'Acme', cursor: '../../bad' }, anchor), /invalid browse cursor/);
    assert.throws(() => store.browse({ entity: 'Acme' }, '2026-03-01'), /asOf must be/);
    assert.throws(() => store.browse({ entity: 'Acme', since: '2026-02-30' }, anchor), /invalid since date/);
    assert.throws(() => store.browse({ entity: 'Acme', since: '2026-03-02' }, anchor), /since must not be later/);
    assert.throws(() => store.browse({ entity: 'Acme', limit: 101 }, anchor), /limit must be/);
    assert.throws(() => store.browse({ entity: 'Acme', limit: 0 }, anchor), /limit must be/);
    assert.equal(store.browse({ entity: 'Acme', until: '2026-02-01' }, anchor).results.length, 3, 'until date includes its full UTC day');
  } finally { store.close(); }
});

test('historical-index browse uses only its captured FTS partition and checks full source body hashes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fabench-browse-'));
  const source = join(dir, 'source.db'), index = join(dir, 'frozen.db');
  try {
    const writer = new CorpusStore(source, 'rarity', 'write');
    writer.ingest([
      ...Array.from({ length: 23 }, (_, i) => ({ url: `https://example.test/${i}`, title: `Acme ${i}`, body: 'Acme historical body', crawlDate: '2026-02-01T00:00:00Z' })),
      { url: 'https://example.test/future', title: 'Acme FutureOnlyIdentifier', body: 'FutureOnlyIdentifier outcome', crawlDate: '2026-03-02T00:00:00Z' },
    ]);
    writer.close();
    await buildFrozenIndex(source, index, anchor, { minimumFreeBytes: 0 });
    const frozen = new CorpusStore(index);
    try {
      const first = frozen.browse({ entity: 'Acme', limit: 20 }, anchor);
      assert.equal(first.results.length, 20);
      assert.ok(first.nextCursor);
      const second = frozen.browse({ entity: 'Acme', limit: 20, cursor: first.nextCursor }, anchor);
      assert.equal(second.results.length, 3);
      assert.equal(second.nextCursor, null);
      assert.ok([...first.results, ...second.results].every(row => row.body === 'Acme historical body'));
      assert.deepEqual(frozen.browse({ entity: 'FutureOnlyIdentifier' }, anchor).results, []);
      assert.throws(() => frozen.browse({ entity: 'Acme' }, '2026-03-02T00:00:00Z'), /exact capture anchor/);
    } finally { frozen.close(); }
    // A broken old capture must not be materialized while returning the newest
    // page; it must be rejected when the user actually reaches its page.
    const corrupt = new DatabaseSync(index);
    corrupt.prepare('UPDATE frozen_documents SET body_sha256=? WHERE id=1').run(Buffer.alloc(32));
    corrupt.close();
    const checked = new CorpusStore(index);
    try {
      const first = checked.browse({ entity: 'Acme', limit: 20 }, anchor);
      assert.equal(first.results.length, 20);
      assert.ok(first.nextCursor);
      assert.throws(() => checked.browse({ entity: 'Acme', cursor: first.nextCursor! }, anchor), /differs from captured bytes/);
    } finally { checked.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
