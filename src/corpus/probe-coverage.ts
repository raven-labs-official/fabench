/**
 * Ask the frozen index a question it was never asked directly: for a piece of evidence a
 * forecaster needed, WAS IT THERE on the as-of date?
 *
 * WHY THIS EXISTS. Every previous verdict on retrieval coverage was inferred from what a model
 * happened to search for. That conflates three different failures which need different fixes:
 *
 *   source     the evidence is not in the index at all — add feeds
 *   retrieval  it is in the index but did not come back for the model's queries — fix ranking
 *   reasoning  it came back and was misread — fix the harness
 *
 * A model transcript cannot separate the first two, because a model that asked the wrong
 * question and a corpus that lacks the answer look identical from the outside. Probing the store
 * directly with queries written from the KNOWN outcome does separate them: if a hindsight query
 * finds the document, the corpus had it and retrieval or reasoning lost it.
 *
 * The as-of filter stays on. A probe that ignored it would answer a different and useless
 * question — "does the corpus contain this document at all" — when what matters is whether the
 * document was reachable at the moment the forecast was made.
 *
 * Usage:
 *   pnpm corpus:probe -- --file probes.json [--db path] [--limit 10] [--out results.json]
 *
 * probes.json is [{ id, as_of, needed_at_anchor: [{ claim, queries: [...] }] }] — the shape the
 * abduction step emits.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { CorpusStore, type SearchHit } from "./store.js";
import { corpusDb } from "../paths.js";

/** Same flag parsing as the other corpus scripts on this branch. */
function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

interface Need {
  claim: string;
  queries: string[];
}
interface Probe {
  id: string;
  as_of: string;
  needed_at_anchor: Need[];
}

interface NeedResult {
  claim: string;
  /** Best rank at which any query returned something, across all queries. */
  hits: number;
  queries: Array<{
    query: string;
    hits: number;
    top: Array<{ title: string; url: string; crawlDate: string; score: number }>;
  }>;
}

function main() {
  const file = arg("file");
  const out = arg("out", "");
  const limit = Number(arg("limit", "10"));
  const dbPath = arg("db", corpusDb());
  if (!file) {
    console.error("usage: corpus:probe -- --file <probes.json> [--db <path>] [--limit N] [--out <results.json>]");
    process.exit(2);
  }

  const probes = JSON.parse(readFileSync(file, "utf8")) as Probe[];
  // "auto" opens an existing file read-only: a probe must never be able to change the thing it
  // is measuring.
  const store = new CorpusStore(dbPath, "rarity", "auto");

  const results: Array<{ id: string; as_of: string; needs: NeedResult[]; anyHit: boolean }> = [];
  let done = 0;
  for (const p of probes) {
    const needs: NeedResult[] = [];
    for (const need of p.needed_at_anchor ?? []) {
      const queries = [];
      let best = 0;
      for (const q of need.queries ?? []) {
        let hits: SearchHit[] = [];
        try {
          hits = store.search(q, p.as_of, limit);
        } catch (e) {
          // A malformed FTS expression is a bad probe, not a missing document. Recording it as
          // zero hits would count it as a corpus gap, which is the one conclusion it cannot
          // support.
          queries.push({ query: q, hits: -1, top: [], error: String(e).slice(0, 120) } as never);
          continue;
        }
        best = Math.max(best, hits.length);
        queries.push({
          query: q,
          hits: hits.length,
          top: hits.slice(0, 3).map((h) => ({
            title: h.title,
            url: h.url,
            crawlDate: h.crawlDate,
            score: h.score,
          })),
        });
      }
      needs.push({ claim: need.claim, hits: best, queries });
    }
    results.push({ id: p.id, as_of: p.as_of, needs, anyHit: needs.some((n) => n.hits > 0) });
    done++;
    if (done % 10 === 0) console.error(`[INFO] probed ${done}/${probes.length}`);
  }
  store.close();

  const withHits = results.filter((r) => r.anyHit).length;
  const needTotal = results.reduce((a, r) => a + r.needs.length, 0);
  const needHit = results.reduce((a, r) => a + r.needs.filter((n) => n.hits > 0).length, 0);
  console.log(`Questions: ${results.length} · at least one evidence item found before the anchor: ${withHits} (${((100 * withHits) / results.length).toFixed(0)}%)`);
  console.log(`Evidence items: ${needTotal} · found before the anchor: ${needHit} (${((100 * needHit) / needTotal).toFixed(0)}%)`);
  if (out) {
    writeFileSync(out, JSON.stringify(results, null, 1));
    console.log(`Details → ${out}`);
  }
}

main();
