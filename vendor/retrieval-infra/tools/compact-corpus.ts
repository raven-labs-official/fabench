/** Compacts a CC-News corpus by encoding article bodies, then verifies and benchmarks the copy.
 *
 *   train   source.db dictionary.bin [samples]
 *   build   source.db compacted.db dictionary.bin [copy|skip]
 *   verify  source.db compacted.db [frozen-index.db ...]
 *   rebuild-fts compacted.db
 *   compare frozen-index.db compacted.db queries.json [limit]
 *
 * "compare" runs each recorded search against the frozen index twice, reading bodies from the
 * recorded source and from the compacted copy, and reports any difference and the latency of both.
 * queries.json is an array of entries that are either {"query": "...", "asOf": "ISO time", "n": 10},
 * a model's search as recorded in a trace, run through the experiment's frozen query path, or
 * {"expression": "...", "asOf": "ISO time"}, one full-text expression.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compactCorpus, rebuildCompactedFts, trainCorpusDictionary, verifyCompaction } from '../src/corpus/compaction.js';
import { dictionarySha256 } from '../src/corpus/body-codec.js';
import { CorpusStore } from '../src/corpus/store.js';
import { queryFrozen } from '../src/corpus/frozen-query.js';

const [command, ...args] = process.argv.slice(2);
const abort = new AbortController();
process.on('SIGTERM', () => abort.abort()); process.on('SIGINT', () => abort.abort());
const log = (value: unknown) => console.log(JSON.stringify(value));

if (command === 'train') {
  const [source, out, samples] = args;
  if (!source || !out) throw new Error('train source.db dictionary.bin [samples] required');
  const count = samples === undefined ? undefined : Number(samples);
  if (count !== undefined && !(Number.isInteger(count) && count > 0)) throw new Error('samples must be a positive integer');
  const dictionary = trainCorpusDictionary(source, count);
  writeFileSync(out, dictionary, { flag: 'wx' });
  log({ dictionary: out, bytes: dictionary.length, sha256: dictionarySha256(dictionary) });
} else if (command === 'build') {
  const [source, target, dictionaryPath, fts] = args;
  if (!source || !target || !dictionaryPath || (fts && fts !== 'copy' && fts !== 'skip'))
    throw new Error('build source.db compacted.db dictionary.bin [copy|skip] required');
  const progress = await compactCorpus(source, target, readFileSync(dictionaryPath), {
    fts: (fts ?? 'copy') as 'copy' | 'skip', signal: abort.signal, onProgress: p => log(p),
  });
  log(progress);
} else if (command === 'verify') {
  const [source, target, ...frozenIndexes] = args;
  if (!source || !target) throw new Error('verify source.db compacted.db [frozen-index.db ...] required');
  log(verifyCompaction(source, target, { frozenIndexes, onProgress: id => { if (id % 1_000_000 < 20_000) log({ checkedId: id }); } }));
} else if (command === 'rebuild-fts') {
  const [target] = args;
  if (!target) throw new Error('rebuild-fts compacted.db required');
  log(await rebuildCompactedFts(target, { onProgress: id => { if (id % 1_000_000 < 5_000) log({ indexedId: id }); } }));
} else if (command === 'compare') {
  const [index, compacted, queriesPath, limitText] = args;
  if (!index || !compacted || !queriesPath) throw new Error('compare frozen-index.db compacted.db queries.json [limit] required');
  const limit = limitText ? Number(limitText) : 10;
  if (!(Number.isInteger(limit) && limit > 0 && limit <= 100)) throw new Error('limit must be an integer from 1 to 100');
  type Recorded = { asOf: string } & ({ expression: string } | { query: string; n?: number });
  const queries = JSON.parse(readFileSync(queriesPath, 'utf8')) as Recorded[];
  const run = (store: CorpusStore, q: Recorded) => 'expression' in q
    ? store.searchRaw(q.expression, q.asOf, limit) : queryFrozen(store, undefined, q.query, q.n ?? limit, q.asOf).hits;
  const original = new CorpusStore(index, 'rarity', 'auto');
  const rewritten = new CorpusStore(index, 'rarity', 'auto', { frozenSourcePath: compacted });
  const times: Record<'original' | 'compacted', number[]> = { original: [], compacted: [] };
  const mismatches: Recorded[] = [];
  try {
    queries.forEach((q, i) => {
      // Alternate which copy runs first so the operating system's file cache favours neither.
      const order = i % 2 ? (['compacted', 'original'] as const) : (['original', 'compacted'] as const);
      const results: Record<string, string> = {};
      for (const which of order) {
        const store = which === 'original' ? original : rewritten;
        const started = performance.now();
        results[which] = JSON.stringify(run(store, q));
        times[which].push(performance.now() - started);
      }
      if (results.original !== results.compacted) mismatches.push(q);
    });
  } finally { original.close(); rewritten.close(); }
  const quantile = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
  const summary = (xs: number[]) => ({ p50: quantile(xs, 0.5), p90: quantile(xs, 0.9), p99: quantile(xs, 0.99), meanMs: xs.reduce((a, b) => a + b, 0) / (xs.length || 1) });
  log({ queries: queries.length, limit, mismatches: mismatches.length, firstMismatches: mismatches.slice(0, 5),
    originalMs: summary(times.original), compactedMs: summary(times.compacted) });
  if (mismatches.length) process.exitCode = 1;
} else {
  throw new Error('command must be train, build, verify, rebuild-fts or compare');
}
