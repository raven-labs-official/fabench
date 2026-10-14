import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { BRAVE_SEARCH_CONFIG, createSearchProvider } from "./search-providers.js";
import { providerDateCutoff } from "./search-backend.js";
import { anchorUtc } from "../corpus/historical-snapshot.js";

const { values } = parseArgs({ options: {
  provider: { type: "string", default: "serper" }, q: { type: "string" }, "as-of": { type: "string" },
  n: { type: "string", default: "10" }, out: { type: "string" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log('Usage: pnpm search:web --provider brave|serper --q "Federal Reserve" --as-of 2026-03-01 [--n 10] [--out FILE]');
} else {
  if (!values.q?.trim() || !values["as-of"]) throw new Error("--q and --as-of are required");
  anchorUtc(values["as-of"]);
  const n = Number(values.n);
  if (!Number.isSafeInteger(n) || n < 1 || n > 20) throw new Error("--n must be an integer from 1 to 20");
  const provider = createSearchProvider(values.provider);
  const cutoff = providerDateCutoff(values["as-of"]);
  const requestedAt = new Date().toISOString();
  const results = await provider.search(values.q, n, cutoff);
  const output = JSON.stringify({ schema: "raven.search-provider-probe.v1", mode: "unfiltered-candidates",
    query: values.q, asOf: values["as-of"], requestedAt, completedAt: new Date().toISOString(),
    provider: provider.name, providerDateCutoff: cutoff, requestedResults: n,
    ...(provider.name === "brave" ? { config: BRAVE_SEARCH_CONFIG } : {}), results, stats: provider.stats() }, null, 2) + "\n";
  if (values.out) writeFileSync(values.out, output, { flag: "wx" });
  else process.stdout.write(output);
}
