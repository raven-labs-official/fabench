/** Re-run saved queries against the same read-only corpus, without forecasting calls. */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CorpusStore, contentTerms } from '../src/corpus/store.js';
import { querySnippet } from '../src/retrieval/snippet.js';

const [input, output, baselineRoot, corpusPath, candidatePath = corpusPath] = process.argv.slice(2);
if (!input || !output || !baselineRoot || !corpusPath) throw new Error('input output baseline-release-root corpus-db required');
const { CorpusStore: OriginalStore } = await import(pathToFileURL(`${baselineRoot}/src/corpus/store.ts`).href);
const baseline = new OriginalStore(corpusPath);
const candidate = new CorpusStore(candidatePath);
const rows: any[] = JSON.parse(readFileSync(input, 'utf8'));
const results: any[] = [];
const coverage = (text: string, q: string) => {
  const terms = contentTerms(q);
  return terms.length ? terms.filter(t => text.toLowerCase().includes(t)).length / terms.length : null;
};
try {
  for (const [i, row] of rows.entries()) {
    const t0 = performance.now();
    const old = baseline.search(row.query, row.as_of, 10);
    const t1 = performance.now();
    const next = candidate.search(row.query, row.as_of, 10);
    const t2 = performance.now();
    const compared = next.map((hit: any) => {
      const head = hit.body.replace(/\s+/g, ' ').slice(0, 260);
      const snippet = querySnippet(hit.body, row.query, 260);
      return { url: hit.url, title: hit.title, crawlDate: hit.crawlDate, head, snippet,
        head_term_coverage: coverage(head, row.query), snippet_term_coverage: coverage(snippet, row.query) };
    });
    results.push({ question_id: row.question_id, query: row.query, as_of: row.as_of,
      original_urls: old.map((h: any) => h.url), candidate: compared,
      baseline_corpus: corpusPath, candidate_corpus: candidatePath,
      original_scores: old.map((h: any) => h.score), candidate_scores: next.map((h: any) => h.score),
      old_ms: t1-t0, new_ms: t2-t1 });
    writeFileSync(output, JSON.stringify(results, null, 2)+'\n');
    if ((i+1)%10 === 0) console.log(`offline replay ${i+1}/${rows.length}`);
  }
} finally { baseline.close(); candidate.close(); }
