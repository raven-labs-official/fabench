/**
 * Build the evidence packet a PERFECT RETRIEVER would have produced — real articles, no summary.
 *
 * WHY. The first oracle arm handed the model claims written by a hindsight analysis, and it cut
 * Brier from 0.43 to 0.17. That number cannot be read as "retrieval was the bottleneck", because
 * the packet did two things at once: it found the right material, and it distilled that material
 * into the one sentence that settles the question. A real retriever does only the first. The
 * giveaway is that questions judged, blind, to be genuinely undetermined at the anchor improved
 * as much as any other class — which honest pre-anchor evidence cannot do, and hindsight
 * SELECTION can.
 *
 * So this script rebuilds the packet from the corpus itself: the same hindsight queries, the same
 * as-of filter, but what comes back is article text. Nothing is written by a model that knew the
 * outcome. Running the oracle arm on this packet splits the gap:
 *
 *   raw ≈ curated    the value was in the documents → retrieval is the bottleneck
 *   raw ≈ none       the value was in the distillation → finding the pages is not enough, and
 *                    the work is in recognising which page matters
 *
 * The queries are still written with hindsight, so this is still a ceiling on retrieval — no
 * anchor-time model knows the perfect query. It is a ceiling on RETRIEVAL specifically, which is
 * the thing the first arm could not isolate.
 *
 * Output is the shape oracle-evidence.ts already consumes, so the two arms differ in the packet
 * and in nothing else.
 *
 * Usage:
 *   tsx src/experiments/build-retrieved-packet.ts --abduction abduction.json --out packets.json \
 *     [--per-query 3] [--max-docs 8] [--chars 1200]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { CorpusStore, type SearchHit } from "../corpus/store.js";
import { corpusDb } from "../paths.js";

function arg(name: string, fallback = ""): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return (i >= 0 ? argv[i + 1] : undefined) ?? fallback;
}

interface Need {
  claim: string;
  queries: string[];
  public_before_anchor?: boolean;
}
interface Abduced {
  id: string;
  as_of: string;
  needed_at_anchor: Need[];
}

function main() {
  const abductionPath = arg("abduction");
  const out = arg("out");
  const perQuery = Number(arg("per-query", "3"));
  const maxDocs = Number(arg("max-docs", "8"));
  const chars = Number(arg("chars", "1200"));
  const dbPath = arg("db", corpusDb());
  if (!abductionPath || !out) {
    console.error("usage: build-retrieved-packet --abduction <f> --out <f> [--per-query 3] [--max-docs 8] [--chars 1200]");
    process.exit(2);
  }

  const abduced = JSON.parse(readFileSync(abductionPath, "utf8")) as Abduced[];
  const store = new CorpusStore(dbPath, "rarity", "auto");
  const packets: Array<{ id: string; as_of: string; needed_at_anchor: Array<{ claim: string }> }> = [];
  let emptyQuestions = 0;
  let done = 0;

  for (const a of abduced) {
    // Interleave one hit per query before taking a second from any of them, so a single
    // productive query cannot crowd out the others. A packet drawn entirely from one query
    // would answer a narrower question than the abduction said needed answering.
    const perQueryHits: SearchHit[][] = [];
    for (const need of a.needed_at_anchor ?? []) {
      if (need.public_before_anchor === false) continue;
      for (const q of need.queries ?? []) {
        try {
          perQueryHits.push(store.search(q, a.as_of, perQuery));
        } catch {
          // A malformed FTS expression is a bad query, not a missing document.
        }
      }
    }
    const seen = new Set<string>();
    const picked: SearchHit[] = [];
    for (let rank = 0; rank < perQuery && picked.length < maxDocs; rank++) {
      for (const hits of perQueryHits) {
        const h = hits[rank];
        if (!h || seen.has(h.url) || picked.length >= maxDocs) continue;
        seen.add(h.url);
        picked.push(h);
      }
    }
    if (picked.length === 0) {
      emptyQuestions++;
      continue;
    }
    packets.push({
      id: a.id,
      as_of: a.as_of,
      // Article text verbatim, with the crawl date the isolation filter ran on, so the model
      // can weigh recency the way it would with a real search result.
      needed_at_anchor: picked.map((h) => ({
        claim: `[${h.crawlDate.slice(0, 10)}] ${h.title}\n${h.body.slice(0, chars).trim()}`,
      })),
    });
    done++;
    if (done % 20 === 0) console.error(`[INFO] ${done}/${abduced.length}`);
  }
  store.close();

  const docs = packets.reduce((a, p) => a + p.needed_at_anchor.length, 0);
  console.log(`${packets.length} questions · ${docs} articles · ${(docs / packets.length).toFixed(1)} articles/question on average`);
  if (emptyQuestions) console.log(`Skipped with zero hits: ${emptyQuestions} questions`);
  writeFileSync(out, JSON.stringify(packets, null, 1));
  console.log(`→ ${out}`);
}

main();
