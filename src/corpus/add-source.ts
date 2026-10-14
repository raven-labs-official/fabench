/**
 * Add documents from any feed to the frozen index.
 *
 * The index started as one CC-NEWS build, and that shaped the ingest path: it read WARC and
 * nothing else. But CC-NEWS is not the whole news web — the wires block Common Crawl in
 * robots.txt, so Reuters and AP appear only through republication, and CCBot is refused
 * outright by a long tail of publishers. Closing those gaps means adding feeds, so ingest has
 * to be feed-agnostic.
 *
 * What a feed must supply is fixed and short, because it is what the benchmark's guarantee
 * rests on:
 *
 *   url        identity, and what dedup keys on
 *   title      what search matches against, along with the body
 *   body       the article text
 *   crawlDate  WHEN THIS TEXT WAS OBSERVED — not the publication date the page claims
 *
 * That last one is the whole invariant. Retrieval filters on `crawl_ms <= anchor`, and the
 * reason that filter means anything is that a crawl timestamp records a physical fact: the
 * bytes existed at that moment, so they cannot contain anything from after it. A feed that
 * can only offer a self-reported publication date does not qualify — a page edited after
 * publication keeps its old date, which is the failure mode the whole design exists to avoid.
 * Feeds that CAN supply a real observation time include Common Crawl (WARC-Date), the Wayback
 * Machine (capture timestamp), and any archive you run yourself.
 *
 * Usage:
 *   pnpm corpus:add -- --source gdelt --file docs.jsonl [--db path]
 *
 * Each line of the JSONL must be {url, title, body, crawlDate}. Documents whose host the
 * domain policy denies are dropped, and the count is reported rather than absorbed.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { CorpusStore, type CorpusDoc } from "./store.js";
import { corpusDb } from "../paths.js";
import { isJunkHost, hostOf, wireSource } from "./domain-policy.js";

function arg(name: string, fallback = ""): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return (i >= 0 ? argv[i + 1] : undefined) ?? fallback;
}

interface Line {
  url?: string;
  title?: string;
  body?: string;
  crawlDate?: string;
  crawl_date?: string;
  wire?: string;
}

async function main() {
  const source = arg("source");
  const file = arg("file");
  const dbPath = arg("db", corpusDb());
  if (!source || !file) {
    console.error("usage: corpus:add -- --source <name> --file <docs.jsonl> [--db <path>]");
    process.exit(2);
  }
  if (!existsSync(file)) {
    console.error(`no such file: ${file}`);
    process.exit(2);
  }

  const store = new CorpusStore(dbPath, "rarity", "write");
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });

  let read = 0;
  let denied = 0;
  let malformed = 0;
  let added = 0;
  let batch: CorpusDoc[] = [];

  const flush = () => {
    if (batch.length) added += store.ingest(batch);
    batch = [];
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    read++;
    let d: Line;
    try {
      d = JSON.parse(line) as Line;
    } catch {
      malformed++;
      continue;
    }
    const crawlDate = d.crawlDate ?? d.crawl_date;
    // Every field is required. Filling a missing crawlDate with "now" would let a document of
    // unknown age into an index whose only guarantee is that ages are known.
    if (!d.url || !d.title || !d.body || !crawlDate || Number.isNaN(Date.parse(crawlDate))) {
      malformed++;
      continue;
    }
    const host = hostOf(d.url);
    if (!host) {
      malformed++;
      continue;
    }
    // Same policy as the CC-NEWS path: one index, one set of rules about what belongs in it.
    if (isJunkHost(host)) {
      denied++;
      continue;
    }
    batch.push({
      url: d.url,
      title: d.title,
      body: d.body,
      crawlDate,
      // Detected the same way for every feed, so "how much wire copy do we hold" stays one
      // question rather than one per source.
      wire: d.wire ?? wireSource(d.body) ?? undefined,
      source,
    });
    if (batch.length >= 2000) flush();
  }
  flush();

  const stats = store.sourceStats();
  store.close();

  console.log(`Source "${source}": read ${read} · added ${added} · dropped by domain policy ${denied} · malformed ${malformed}`);
  console.log(`\nSources now in the corpus:`);
  for (const s of stats) {
    console.log(
      `  ${s.source.padEnd(14)} ${String(s.docs).padStart(10)} docs   ${s.earliest.slice(0, 10)} ~ ${s.latest.slice(0, 10)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
