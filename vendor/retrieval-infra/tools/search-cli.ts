/**
 * Search either corpus by hand and read what comes back.
 *
 * Every finding in this project rests on "what does the retrieval layer actually return for this
 * question at this date", and until now the only way to see that was to run an experiment and read
 * a trace afterwards. That is too slow to argue with. This puts the same two backends behind one
 * command so a person can type a query, pin an as-of date, and look at the titles, dates and URLs.
 *
 * The as-of date is not optional decoration. Both backends gate on it, and a query without one is
 * a different question from the one the benchmark asks — so it is required rather than defaulted
 * to today, which would silently answer "what can I find now" and look identical.
 *
 * Usage:
 *   pnpm search -- --corpus frozen --as-of 2026-03-01 --q "Somaliland recognition"
 *   pnpm search -- --corpus backsearch --as-of 2026-03-01 --q "Somaliland recognition" -n 20
 *   pnpm search -- --corpus frozen --as-of 2026-03-01 --q "Centenaro AND Selvazzano" --fts
 *   pnpm search -- --corpus frozen --as-of 2026-03-01 --q "Cerebras IPO" --show 2   # print bodies
 */
import { CorpusStore } from "../src/corpus/store.js";
import { BackSearchBackend } from "../src/retrieval/backsearch-backend.js";
import { corpusDb } from "../src/paths.js";
import { getEnvKey } from "../src/llm/load-env.js";
import { readFileSync } from "node:fs";
import { RecordedSearchBackend, frozenSnapshotBackend, type SearchSnapshot } from "../src/retrieval/search-snapshot.js";
import { FrozenBackend } from "../src/retrieval/search-backend.js";
import { FrozenWithArchiveBackend, openFrozenArchive } from "../src/retrieval/frozen-with-archive.js";

function arg(name: string, fallback = ""): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return (i >= 0 ? argv[i + 1] : undefined) ?? fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const USAGE = `
Usage:
  pnpm search -- --q "<keywords>" --as-of <YYYY-MM-DD> [options]

Required:
  --q       Query. By default it goes through the same query rewriting as the experiments;
            with --fts it is passed to FTS5 as written
            (then an exact conjunction such as '"Centenaro" AND "Selvazzano"' works)
  --as-of   Forecast anchor. Only documents captured before this moment are returned, which
            is the time isolation the experiments use

Options:
  --corpus  frozen | backsearch | snapshot | recorded   default frozen
  --snapshot capture file; snapshot accepts new queries, recorded replays recorded queries only
  --frozen-archive-file verified CC capture JSONL; needs a complete historical index, frozen
            only and not with --fts
  -n        number of results, default 10
  --show N  also print the body of the first N results (default 0, titles only)
  --chars   characters of body to print, default 800
  --fts     pass --q to FTS5 as written (frozen only)

Examples:
  pnpm search -- --q "Somaliland recognition" --as-of 2026-03-01
  pnpm search -- --q "Cerebras IPO" --as-of 2026-03-01 --show 2
  pnpm search -- --q '"Centenaro" AND "Selvazzano"' --as-of 2026-03-11 --fts
  pnpm search -- --q "Somaliland recognition" --as-of 2026-03-01 --corpus backsearch
`;

async function main() {
  const q = arg("q");
  const asOfRaw = arg("as-of");
  if (!q || !asOfRaw || flag("help")) {
    console.log(USAGE);
    process.exit(q && asOfRaw ? 0 : 2);
  }
  // Accept a bare date and a full timestamp. A bare date means end of that day, matching how the
  // question set's own date-only anchors are read elsewhere.
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? `${asOfRaw}T23:59:59Z` : asOfRaw;
  if (Number.isNaN(Date.parse(asOf))) throw new Error(`Cannot parse --as-of: ${asOfRaw}`);

  const n = Number(arg("n", "10"));
  const show = Number(arg("show", "0"));
  const chars = Number(arg("chars", "800"));
  const corpus = arg("corpus", "frozen");
  const archiveFile = arg("frozen-archive-file");
  if (archiveFile && (corpus !== "frozen" || flag("fts")))
    throw new Error("--frozen-archive-file only supports frozen queries without --fts");

  console.log(`\nQuery    ${JSON.stringify(q)}${flag("fts") ? "  (FTS5 as written)" : ""}`);
  console.log(`As of    ${asOf}   ← only captures from before this moment`);
  console.log(`Corpus   ${corpus}\n`);

  if (corpus === "snapshot" || corpus === "recorded") {
    if (!arg("snapshot")) throw new Error("This mode needs --snapshot, and --as-of must equal the file's frozenAtUtc");
    if (flag("fts")) throw new Error("snapshot/recorded do not support --fts");
    const snapshot: SearchSnapshot = JSON.parse(readFileSync(arg("snapshot"), "utf8"));
    const isolated = corpus === "snapshot" ? frozenSnapshotBackend(snapshot) : null;
    const backend = isolated?.backend ?? new RecordedSearchBackend(snapshot);
    try {
      const hits = await backend.search(q, n, asOf);
      for (const [i, hit] of hits.entries()) {
        console.log(`${i + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`);
        if (i < show) console.log((await backend.fetch(hit.url, asOf))?.body.slice(0, chars) ?? "(no body was captured)");
      }
      console.log(`${hits.length} results · snapshot ${arg("snapshot")}`);
    } finally { isolated?.close(); }
    return;
  }

  if (corpus === "frozen") {
    if (archiveFile) {
      const archive = openFrozenArchive(archiveFile, corpusDb(), [asOf]);
      let store: CorpusStore | undefined;
      try {
        store = new CorpusStore(corpusDb(), "rarity");
        const backend = new FrozenWithArchiveBackend(new FrozenBackend(store), archive.backend);
        const hits = await backend.search(q, n, asOf);
        for (const [i,h] of hits.entries()) {
          console.log(`${i+1}. [${h.crawlDate}] ${h.title}\n   ${h.url}\n   ${h.snippet}`);
          if (i < show) console.log((await backend.fetch(h.url, asOf))?.body.slice(0, chars) ?? "(body not available)");
        }
        console.log(`${hits.length} results · archive identity ${JSON.stringify(archive.identity)}\nbackend counts ${JSON.stringify(backend.stats())}`);
      } finally { store?.close(); archive.close(); }
      return;
    }
    const store = new CorpusStore(corpusDb(), "rarity", "auto");
    // `search` applies the same query rewriting the experiment uses; `searchRaw` is the escape
    // hatch for a hand-written FTS expression, which is what a conjunctive membership check needs.
    const hits = flag("fts")
      ? store.searchRaw?.(q, asOf, n) ?? store.search(q, asOf, n)
      : store.search(q, asOf, n);
    if (!hits.length) console.log("(no hits)");
    hits.forEach((h, i) => {
      console.log(`${String(i + 1).padStart(3)}. [${h.crawlDate.slice(0, 10)}] ${h.title}`);
      console.log(`     ${h.url}`);
      if (i < show) console.log(`     ${h.body.slice(0, chars).replace(/\s+/g, " ")}\n`);
    });
    console.log(`\n${hits.length} results · corpus ${corpusDb()}`);
    store.close();
    return;
  }

  if (corpus === "backsearch") {
    const key = getEnvKey("OPENREWARD_API_KEY");
    if (!key) throw new Error("backsearch needs OPENREWARD_API_KEY (in team.env)");
    const be = new BackSearchBackend({ apiKey: key, fetchChars: chars });
    const hits = await be.search(q, n, asOf);
    if (!hits.length) console.log("(no hits)");
    for (const [i, h] of hits.entries()) {
      console.log(`${String(i + 1).padStart(3)}. [${(h.crawlDate ?? "?").slice(0, 10)}] ${h.title}`);
      console.log(`     ${h.url}`);
      if (i < show) {
        const doc = await be.fetch(h.url, asOf);
        console.log(`     ${(doc?.body ?? "(body not available)").slice(0, chars)}\n`);
      }
    }
    console.log(`\n${hits.length} results · backend counts ${JSON.stringify(be.stats())}`);
    return;
  }

  throw new Error(`Unknown --corpus "${corpus}"; use frozen | backsearch | snapshot | recorded`);
}

main().catch((e) => {
  console.error(`\n[ERR] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
