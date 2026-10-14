/**
 * Ingest a directory of gzipped CC-News JSONL shards (CC-NEWS-*.jsonl.gz) into ONE
 * frozen corpus store (SQLite FTS5). Streams + gunzips each shard, batched inserts,
 * so it scales to millions of docs without loading anything fully into memory.
 *
 * Each JSON line: { url, title, body, crawlDate } (crawl_date/date_scraped/date accepted).
 *
 * Applies the corpus domain policy on the way in (see domain-policy.ts): template
 * and catalog hosts are dropped, official sources are explicitly preserved, and
 * syndicated wire copy is tagged. Doing this at ingest rather than afterwards
 * matters because it also keeps BM25's IDF statistics free of the junk.
 *
 * Usage:
 *   pnpm exec tsx src/corpus/ingest-ccnews.ts -- <dir> [out.db] [--keep-junk]
 */
import { createReadStream, mkdirSync, readdirSync, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { CorpusStore, type CorpusDoc } from "./store.js";
import { hostOf, isJunkHost, wireSource } from "./domain-policy.js";
// biome-ignore lint/correctness/noUnusedImports: loading paths.js reads the path configuration at startup; removing it would skip that check
import { DATA_DIR } from "../paths.js";

const BATCH = 5000;

function findGz(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...findGz(p));
    else if (e.endsWith(".jsonl.gz")) out.push(p);
  }
  return out;
}

function parseLine(line: string): CorpusDoc | null {
  const raw = JSON.parse(line) as Record<string, unknown>;
  const crawlDate = (raw.crawlDate ?? raw.crawl_date ?? raw.date_scraped ?? raw.date) as
    | string
    | undefined;
  const url = raw.url as string | undefined;
  const title = (raw.title ?? "") as string;
  const body = (raw.body ?? raw.text ?? "") as string;
  if (!url || !crawlDate || !body) return null;
  return { url, title, body, crawlDate };
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const keepJunk = argv.includes("--keep-junk");
  const args = argv.filter((a) => !a.startsWith("--"));
  // Accept MANY source directories, and require the output path to be named explicitly.
  //
  // The shards for one corpus are not in one place: 2025-09 and 2025-10 live under
  // cc-news-2025q4/ (1,151 shards) while 2025-11 onward live under cc-news-2026/ (3,512).
  // With a single positional directory, anyone following the documented command rebuilds a
  // corpus that is silently missing two months and reports success — the exact failure mode
  // this project keeps hitting, and a fatal one for a benchmark that asks others to
  // reproduce its index. Taking a list makes the omission impossible to make by accident.
  const outFlag = argv.indexOf("--out");
  const dbPath = outFlag >= 0 ? argv[outFlag + 1] : undefined;
  const dirs = args.filter((a) => a !== dbPath);
  if (!dirs.length || !dbPath) {
    console.error("Usage: ingest-ccnews -- <dir-of-.jsonl.gz> [more dirs...] --out <db> [--keep-junk]");
    console.error("Note: pass EVERY shard directory. The corpus spans more than one.");
    process.exit(1);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new CorpusStore(dbPath, "rarity", "write");
  // Sorted across the union, not per directory, so shard order — and therefore rowid
  // assignment — does not depend on the order the directories were typed in.
  const files = dirs.flatMap((d) => findGz(d)).sort();
  const perDir = dirs.map((d) => `${d.split("/").pop()}=${findGz(d).length}`).join(" ");
  console.log(`${files.length} shards from ${dirs.length} dir(s) [${perDir}] → ${dbPath}${keepJunk ? "  (domain policy DISABLED)" : ""}`);

  let ingested = 0;
  let skipped = 0;
  let junked = 0;
  let wired = 0;
  const junkByHost = new Map<string, number>();
  let fileNo = 0;
  const t0 = Date.now();

  for (const file of files) {
    fileNo++;
    const rl = createInterface({
      input: createReadStream(file).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    let batch: CorpusDoc[] = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      let doc: CorpusDoc | null = null;
      try {
        doc = parseLine(line);
      } catch {
        doc = null;
      }
      if (!doc) {
        skipped++;
        continue;
      }
      const host = hostOf(doc.url);
      if (!keepJunk && isJunkHost(host)) {
        junked++;
        junkByHost.set(host, (junkByHost.get(host) ?? 0) + 1);
        continue;
      }
      doc.wire = wireSource(doc.body);
      if (doc.wire) wired++;
      batch.push(doc);
      if (batch.length >= BATCH) {
        ingested += store.ingest(batch);
        batch = [];
      }
    }
    if (batch.length) ingested += store.ingest(batch);
    if (fileNo % 50 === 0 || fileNo === files.length) {
      const dt = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(
        `  [${fileNo}/${files.length}] ingested=${ingested.toLocaleString()} junk=${junked.toLocaleString()} wire=${wired.toLocaleString()} skipped=${skipped.toLocaleString()} ${dt}s`,
      );
    }
  }

  store.close();
  const seen = ingested + junked;
  console.log(
    `OK: ${ingested.toLocaleString()} docs ingested, ${skipped.toLocaleString()} unparseable.\n` +
      `    domain policy dropped ${junked.toLocaleString()} (${((junked / Math.max(1, seen)) * 100).toFixed(2)}% of parsed)\n` +
      `    wire copy tagged ${wired.toLocaleString()} (${((wired / Math.max(1, ingested)) * 100).toFixed(2)}% of ingested)`,
  );
  if (junked > 0) {
    console.log(`    top dropped hosts:`);
    for (const [h, n] of [...junkByHost].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`      ${String(n).padStart(8)}  ${h}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
