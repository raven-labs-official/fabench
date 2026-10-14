import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { collectWikipedia, type Downloader } from "./historical-adapters.js";
import { anchorUtc } from "./historical-snapshot.js";

/** One on-demand API read; no corpus download, indexing, or implicit file writes. */
export async function readWikipediaHistory(title: string, asOf: string, language = "en", maxChars = 8000, get?: Downloader) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new Error("max-chars must be a nonnegative integer; 0 means full text");
  const doc = await collectWikipedia({ source: "wikipedia", title, language }, asOf, get);
  return { title: doc.title, url: doc.url, originalUrl: doc.originalUrl, asOf: anchorUtc(asOf),
    evidence: doc.evidence, format: "historical-wikitext", fullBodyChars: doc.body.length,
    truncated: maxChars > 0 && doc.body.length > maxChars, text: maxChars > 0 ? doc.body.slice(0, maxChars) : doc.body };
}

async function main() {
  const { values } = parseArgs({ options: {
    title: { type: "string" }, "as-of": { type: "string" }, lang: { type: "string", default: "en" },
    "max-chars": { type: "string", default: "8000" }, out: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log('Usage: pnpm wikipedia:history --title "Federal Reserve" --as-of 2026-03-01T00:00:00Z [--lang en] [--max-chars 8000] [--out FILE]');
    return;
  }
  if (!values.title || !values["as-of"]) throw new Error("--title and --as-of are required");
  const result = await readWikipediaHistory(values.title, values["as-of"], values.lang, Number(values["max-chars"]));
  const output = JSON.stringify(result, null, 2) + "\n";
  if (values.out) writeFileSync(values.out, output, { flag: "wx" });
  else process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
