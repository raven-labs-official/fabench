import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { collectWayback, collectWikipedia, type HistoricalSeed } from "./historical-adapters.js";
import { anchorUtc, hash, validateSnapshot, type HistoricalSnapshot } from "./historical-snapshot.js";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const planPath = flag("--plan"), output = flag("--out");
if (!planPath || !output) throw new Error("Usage: pnpm corpus:historical --plan PLAN.json --out SNAPSHOT.json");
const raw = readFileSync(planPath, "utf8");
const plan = JSON.parse(raw) as { asOf: string; selection: string; sources: HistoricalSeed[] };
anchorUtc(plan.asOf);
if (!Array.isArray(plan.sources) || !plan.sources.length || plan.sources.length > 100 || !plan.selection?.trim()) {
  throw new Error("Plan requires a selection description and 1–100 explicit seeds");
}
const snapshot: HistoricalSnapshot = { schema: "raven.historical-snapshot.v1", asOf: plan.asOf,
  selection: plan.selection, planSha256: hash(raw), documents: [] };
for (const seed of plan.sources) {
  const doc = seed.source === "wikipedia" ? await collectWikipedia(seed, plan.asOf)
    : seed.source === "wayback" ? await collectWayback(seed, plan.asOf)
    : (() => { throw new Error("Unsupported historical source"); })();
  snapshot.documents.push(doc);
  console.log(JSON.stringify({ source: doc.evidence.kind, version: doc.evidence.version, availableAt: doc.evidence.availableAt }));
}
validateSnapshot(snapshot);
const text = JSON.stringify(snapshot, null, 2) + "\n";
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, text, { flag: "wx" });
console.log(JSON.stringify({ output: resolve(output), documents: snapshot.documents.length, sha256: hash(text) }));
