/** Read-only fixed-query diagnostic. Input: JSON array of queries; output excludes bodies. */
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { CorpusStore } from '../src/corpus/store.js';
import { CONCEPT_QUERY_POLICY } from '../src/corpus/query-plan.js';
import { FROZEN_QUERY_POLICY } from '../src/corpus/query-identity.js';
const { values } = parseArgs({ options: { corpus: { type: 'string' }, queries: { type: 'string' },
  'as-of': { type: 'string' }, out: { type: 'string' }, n: { type: 'string', default: '10' } } });
if (!values.corpus || !values.queries || !values['as-of'] || !values.out) throw new Error('--corpus --queries --as-of --out required');
const queries: unknown = JSON.parse(readFileSync(values.queries, 'utf8'));
if (!Array.isArray(queries) || !queries.every(q => typeof q === 'string')) throw new Error('queries must be a JSON string array');
const limit = Number(values.n);
const variants = [];
for (const mode of ['rarity', 'concept'] as const) {
  const store = new CorpusStore(values.corpus, mode);
  const seen = new Set<string>(), results = [];
  try {
    for (const query of queries) {
      const start = performance.now();
      const planned = mode === 'concept' ? store.searchPlanned(query, values['as-of'], limit) : undefined;
      const hits = planned?.hits ?? store.search(query, values['as-of'], limit);
      const ms = performance.now() - start;
      const newUrls = hits.filter(h => !seen.has(h.url)).length;
      hits.forEach(h => seen.add(h.url));
      results.push({ query, ms, newUrls, hits: hits.map(({ body, ...hit }) => ({ ...hit, bodyChars: body.length })),
        ...(planned ? { plan: planned.plan, routes: planned.routes } : {}) });
    }
  } finally { store.close(); }
  variants.push({ mode, policy: mode === 'concept' ? CONCEPT_QUERY_POLICY : FROZEN_QUERY_POLICY, uniqueUrls: seen.size, results });
}
const source = statSync(values.corpus);
writeFileSync(values.out, JSON.stringify({ scope: 'fixed corpus/query diagnostic; URL counts are not fact recall',
  corpus: { path: values.corpus, bytes: source.size, mtimeMs: source.mtimeMs }, asOf: values['as-of'], variants }, null, 2) + '\n', { flag: 'wx', mode: 0o640 });
console.log(JSON.stringify(variants.map(v => ({ mode: v.mode, uniqueUrls: v.uniqueUrls,
  firstSixUniqueUrls: new Set(v.results.slice(0, 6).flatMap(r => r.hits.map(h => h.url))).size,
  emptyQueries: v.results.filter(r => !r.hits.length).length,
  ms: v.results.map(r => Math.round(r.ms)) }))));
