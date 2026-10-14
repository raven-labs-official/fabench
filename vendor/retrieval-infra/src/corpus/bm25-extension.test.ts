import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CorpusStore } from './store.js';
import { buildFrozenIndex } from './frozen-index.js';
import { queryFrozen } from './frozen-query.js';
import { clearProjectEnv } from "../env-names.js";

const root = fileURLToPath(new URL('../../', import.meta.url));
const words = ['central', 'bank', 'rates', 'inflation', 'election', 'senate', 'storm', 'hurricane', 'season',
  'market', 'stocks', 'growth', 'policy', 'vote', 'court', 'ruling', 'oil', 'price', 'june', 'year'];

test('bm25_cached ranks frozen routes exactly like the built-in bm25', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bm25-cached-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const so = join(dir, 'raven_bm25.so');
  const built = spawnSync('cc', ['-O2', '-fPIC', '-shared', `-I${root}native/sqlite-3.51.3`, `${root}native/raven_bm25.c`, '-o', so, '-lm']);
  if (built.error || built.status !== 0) { t.skip('no C compiler for the optional extension'); return; }
  const src = join(dir, 'source.db'), index = join(dir, 'index.db');
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const word = () => words[Math.floor(words.length * rnd() * rnd())];
  const store = new CorpusStore(src, 'or', 'write');
  store.ingest(Array.from({ length: 300 }, (_, i) => ({ url: `https://test/${i}`, title: `${word()} ${word()} ${word()}`,
    body: Array.from({ length: 20 + Math.floor(rnd() * 200) }, word).join(' '),
    crawlDate: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 3_600_000).toISOString() })));
  store.close();
  const pad = new DatabaseSync(src); pad.exec('CREATE TABLE padding (x BLOB); INSERT INTO padding VALUES (randomblob(1100000));'); pad.close();
  const anchor = '2026-03-01T00:00:00.000Z';
  return buildFrozenIndex(src, index, anchor, { minimumFreeBytes: 0 }).then(() => {
    const open = (extension: string) => { process.env.FABENCH_BM25_EXTENSION = extension; return new CorpusStore(index, 'rarity', 'auto'); };
    const builtin = open(''), cached = open(so);
    t.after(() => { builtin.close(); cached.close(); clearProjectEnv("FABENCH_BM25_EXTENSION"); });
    assert.equal(builtin.frozenRankFunction, 'bm25'); assert.equal(cached.frozenRankFunction, 'bm25_cached');
    const expressions = ['"bank"', '("central" OR "bank") AND "rates"', '"central bank" AND ("rates" OR "inflation")',
      '("storm" OR "hurricane") AND ("season" OR "june" OR "year")', '"oil" AND "price" AND "market"', '"senate vote"'];
    for (const round of [1, 2]) for (const e of expressions) for (const limit of [3, 30]) {
      const a = builtin.searchRaw(e, anchor, limit), b = cached.searchRaw(e, anchor, limit);
      assert.deepEqual(b.map(h => [h.url, h.score]), a.map(h => [h.url, h.score]), `${e} limit ${limit} round ${round}`);
    }
    for (const query of ['central bank rates inflation', 'hurricane season june', 'senate vote court ruling'])
      assert.deepEqual(queryFrozen(cached, undefined, query, 5, anchor).hits, queryFrozen(builtin, undefined, query, 5, anchor).hits);
  });
});
