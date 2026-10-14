/**
 * E4 — time-isolation test on the real CC-News corpus.
 *
 * The whole benchmark rests on one invariant: a search with cutoff `asOf` must
 * NEVER return a document crawled after asOf. This script checks it directly on
 * real data: for a range of asOf dates it runs the same query and asserts that
 * every returned document's crawl timestamp is ≤ asOf. Any violation = a leak.
 *
 * Usage:
 *   pnpm exec tsx src/corpus/isolation-test.ts -- <corpus.db>
 */
import { CorpusStore } from "./store.js";
import { FrozenCorpusEnv } from "../retrieval/frozen-corpus-env.js";
import { corpusDb } from "../paths.js";

async function main() {
  // Fall back to FABENCH_CORPUS_DB, not to a hard-coded path. The previous default pointed at
  // a corpus name that no longer exists, so running this without an argument failed with
  // "unable to open database file" — the exact message corpusDb() exists to prevent.
  const dbPath = process.argv.slice(2).filter((a) => a !== "--")[0] ?? corpusDb();
  // Read-only: this only searches. "write" was needed back when docs_vocab was created
  // lazily on first search; ingest creates it now. Read-only also runs the corpus guard,
  // so a wrong path names the missing file instead of "unable to open database file".
  const store = new CorpusStore(dbPath, "rarity");
  const env = new FrozenCorpusEnv(store, 30);
  console.log(`corpus: ${store.count().toLocaleString()} docs @ ${dbPath}`);

  const queries = ["government shutdown", "election results", "central bank interest rate"];
  const asOfs = [
    "2025-09-15",
    "2025-10-01",
    "2025-10-18",
    "2025-10-31",
  ];

  let totalLeaks = 0;
  for (const query of queries) {
    console.log(`\nquery: "${query}"`);
    console.log(`  asOf         hits  latest-crawl   leaks(crawl>asOf)`);
    for (const asOf of asOfs) {
      const hits = await env.search(query, asOf);
      const dates = hits.map((h) => h.content_timestamp_utc).sort();
      const latest = dates.at(-1) ?? "—";
      const cutoffMs = new Date(asOf + "T23:59:59Z").getTime();
      const leaks = hits.filter((h) => new Date(h.content_timestamp_utc).getTime() > cutoffMs);
      totalLeaks += leaks.length;
      console.log(
        `  ${asOf}   ${String(hits.length).padStart(4)}  ${latest.slice(0, 10).padEnd(12)}  ${
          leaks.length === 0 ? "0 ✅" : `${leaks.length} ❌ LEAK`
        }`,
      );
      for (const l of leaks.slice(0, 2)) console.log(`        ⚠️  ${l.content_timestamp_utc}  ${l.url}`);
    }
  }

  store.close();
  console.log(
    `\n=== ${totalLeaks === 0 ? "PASS ✅ time isolation holds (0 leaks)" : `FAIL ❌ ${totalLeaks} leaks`} ===`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
