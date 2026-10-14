/**
 * Evidence for (and against) the corpus deny-list.
 *
 * Dropping ~17% of a corpus on the strength of one sampled document per domain is
 * not enough justification, so this dumps auditable evidence for every denied host
 * and, just as importantly, looks for hosts we did NOT deny that behave the same.
 *
 * Two measurable signals separate "templated catalog output" from "journalism":
 *   titleUniq  — distinct titles / sampled docs. Catalogs reuse one title skeleton
 *                across thousands of items ("<Coin> tokenomics", "<A> to <B> rate").
 *   avgLen     — real articles run to thousands of characters; catalog pages are short.
 * Neither is used to decide automatically — they rank candidates for a human read,
 * and the sampled bodies are printed so the call can be checked.
 *
 * Runs against a corpus built BEFORE filtering (the filtered one no longer contains
 * the evidence).
 *
 * Usage:
 *   pnpm exec tsx src/corpus/verify-denylist.ts -- \
 *     [--db path] [--per-host 3] [--top 60]
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installBodyView } from "./body-codec.js";
import { isJunkHost, isPreserved } from "./domain-policy.js";
import { corpusDb } from "../paths.js";

function arg(name: string, fallback: string): string {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return (i >= 0 ? argv[i + 1] : undefined) ?? fallback;
}

const dbPath = arg("db", "") || corpusDb();
const perHost = Number(arg("per-host", "3"));
const topN = Number(arg("top", "60"));
if (!existsSync(dbPath)) {
  console.error(`No such database: ${dbPath}`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
// A compacted corpus stores encoded bodies; read the original text through the shared view.
installBodyView(db);

const HOST_SQL = `CASE WHEN instr(substr(url, instr(url,'://')+3),'/')>0
       THEN substr(substr(url, instr(url,'://')+3), 1, instr(substr(url, instr(url,'://')+3),'/')-1)
       ELSE substr(url, instr(url,'://')+3) END`;

/** Sample up to `limit` docs for a host, cheaply (LIKE on the indexed url prefix). */
function sample(host: string, limit: number) {
  return db
    .prepare(`SELECT title, length(body) AS len, substr(body,1,140) AS head FROM docs WHERE url LIKE ? LIMIT ?`)
    .all(`%//${host}/%`, limit) as { title: string; len: number; head: string }[];
}

/** Templatedness signals over a larger sample, without pulling whole bodies. */
function profile(host: string, n = 400) {
  const rows = db
    .prepare(`SELECT title, length(body) AS len FROM docs WHERE url LIKE ? LIMIT ?`)
    .all(`%//${host}/%`, n) as { title: string; len: number }[];
  if (rows.length === 0) return null;
  const titles = new Set(rows.map((r) => r.title.trim()));
  // Collapse digits/quotes so "BURN tokenomics" and "PEPE tokenomics" count as one shape.
  const shapes = new Set(rows.map((r) => r.title.replace(/[0-9]+/g, "#").replace(/[«»"'’]/g, "").trim().slice(0, 60)));
  return {
    n: rows.length,
    titleUniq: titles.size / rows.length,
    shapeUniq: shapes.size / rows.length,
    avgLen: Math.round(rows.reduce((s, r) => s + r.len, 0) / rows.length),
  };
}

const hosts = db
  .prepare(`SELECT ${HOST_SQL} AS host, COUNT(*) n FROM docs GROUP BY host ORDER BY n DESC LIMIT ?`)
  .all(topN) as { host: string; n: number }[];

console.log(`=== deny-list evidence · ${dbPath} ===\n`);
console.log(`profiling the top ${hosts.length} hosts; each is a separate scan, so this is slow\n`);
console.log(`── A. every DENIED host: signals + sampled bodies ──`);
const denied = hosts.filter((x) => isJunkHost(x.host));
if (denied.length === 0) {
  // Silence here used to be ambiguous: a corpus built with the policy applied contains no
  // denied documents, so there is nothing to sample — which looks identical to a crashed run.
  console.log(
    `\n  none present. This corpus was built with the deny-list applied, so the evidence it\n` +
      `  would show has already been filtered out. To audit the list, ingest with --keep-junk\n` +
      `  and point --db at that build.`,
  );
}
let profiled = 0;
for (const h of denied) {
  const p = profile(h.host);
  console.log(
    `\n[DENY] ${h.host}  ${h.n.toLocaleString()} docs` +
      (p ? `  titleUniq=${p.titleUniq.toFixed(3)} shapeUniq=${p.shapeUniq.toFixed(3)} avgLen=${p.avgLen}` : ""),
  );
  for (const s of sample(h.host, perHost)) {
    console.log(`   · [${s.len}c] ${s.title.slice(0, 72)}`);
    console.log(`       ${s.head.replace(/\s+/g, " ").slice(0, 105)}`);
  }
}

console.log(`\n\n── B. NOT denied, but templated-looking (possible misses) ──`);
console.log(`   (low shapeUniq = few distinct title shapes; short avgLen = not articles)`);
const candidates = hosts.filter((x) => !isJunkHost(x.host) && !isPreserved(x.host));
const suspects = candidates
  .map((x) => {
    process.stderr.write(`\r   profiling ${++profiled}/${candidates.length} …`);
    return { ...x, p: profile(x.host) };
  })
  .filter((x) => x.p && (x.p.shapeUniq < 0.5 || x.p.avgLen < 900))
  .sort((a, b) => a.p!.shapeUniq - b.p!.shapeUniq);
process.stderr.write("\r" + " ".repeat(40) + "\r");
if (suspects.length === 0) console.log(`\n  none — no kept host in the top ${hosts.length} looks templated.`);
for (const s of suspects.slice(0, 12)) {
  console.log(
    `\n[?] ${s.host}  ${s.n.toLocaleString()} docs  titleUniq=${s.p!.titleUniq.toFixed(3)} shapeUniq=${s.p!.shapeUniq.toFixed(3)} avgLen=${s.p!.avgLen}`,
  );
  for (const x of sample(s.host, 2)) {
    console.log(`   · [${x.len}c] ${x.title.slice(0, 72)}`);
    console.log(`       ${x.head.replace(/\s+/g, " ").slice(0, 105)}`);
  }
}

console.log(`\n\n── C. control: hosts we KEEP, for comparison ──`);
const keep = hosts
  .filter((x) => !isJunkHost(x.host) && !isPreserved(x.host))
  .map((x) => ({ ...x, p: profile(x.host) }))
  .filter((x) => x.p && x.p.shapeUniq >= 0.8)
  .slice(0, 5);
for (const s of keep) {
  console.log(`[KEEP] ${s.host.padEnd(34)} shapeUniq=${s.p!.shapeUniq.toFixed(3)} avgLen=${s.p!.avgLen}`);
}

db.close();
