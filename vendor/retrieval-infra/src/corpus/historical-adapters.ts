import { createHash } from "node:crypto";
import { anchorUtc, hash, captureUtc, archivedHtmlText, type HistoricalDocument } from "./historical-snapshot.js";
import { isMarketHost } from "../retrieval/market-blocklist.js";
import { HISTORICAL_USER_AGENT } from "../http-identity.js";

export type HistoricalSeed =
  | { source: "wikipedia"; language: string; title: string }
  | { source: "wayback"; url: string; label: string };
export type Downloader = (url: string) => Promise<{ text: string; headers: Headers }>;

/** No HTTP redirects: archive nearest-capture fallbacks must never silently pass. */
export const download: Downloader = async (url) => {
  const response = await fetch(url, {
    redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": HISTORICAL_USER_AGENT },
  });
  if (response.status !== 200) throw new Error(`Historical source HTTP ${response.status}: ${new URL(url).hostname}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Historical source returned no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5_000_000) throw new Error("Historical response exceeds 5 MB limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), headers: response.headers };
};

export async function collectWikipedia(seed: Extract<HistoricalSeed, { source: "wikipedia" }>, asOf: string, get = download): Promise<HistoricalDocument> {
  if (!/^[a-z-]+$/.test(seed.language) || typeof seed.title !== "string" || !seed.title.trim()) throw new Error("Invalid Wikipedia seed");
  const host = `https://${seed.language}.wikipedia.org`;
  const params = new URLSearchParams({ action: "query", format: "json", formatversion: "2", prop: "revisions",
    titles: seed.title, rvstart: anchorUtc(asOf), rvdir: "older", rvlimit: "1",
    rvprop: "ids|timestamp|sha1|slotsha1|contentmodel|content", rvslots: "main" });
  const { text: raw } = await get(`${host}/w/api.php?${params}`);
  const data = JSON.parse(raw);
  const page = data.query?.pages?.[0];
  const revision = page?.revisions?.[0];
  const body = revision?.slots?.main?.content;
  if (data.error || page?.missing || !Number.isSafeInteger(revision?.revid) || revision.revid <= 0 ||
      typeof body !== "string" || !body.trim() || revision.slots.main.contentmodel !== "wikitext" ||
      typeof revision.timestamp !== "string" || !revision.timestamp.includes("T") ||
      anchorUtc(revision.timestamp) >= anchorUtc(asOf)) throw new Error("No valid pre-anchor Wikipedia revision");
  // Do not resolve today's redirect targets or expand templates using today's definitions.
  if (/^\s*#redirect\b/i.test(body)) throw new Error("Wikipedia redirect requires an explicitly reviewed historical seed");
  if (createHash("sha1").update(body).digest("hex") !== (revision.slots.main.sha1 ?? revision.sha1)) throw new Error("Wikipedia revision SHA-1 mismatch");
  return {
    // Page metadata can reflect a later rename. Only the predeclared seed label is served.
    title: seed.title, url: `${host}/w/index.php?oldid=${revision.revid}`,
    originalUrl: `${host}/wiki/${encodeURIComponent(seed.title.replace(/ /g, "_"))}`, body, raw,
    evidence: { kind: "wikipedia-revision", version: String(revision.revid), availableAt: revision.timestamp,
      acquiredAt: new Date().toISOString(), rawSha256: hash(raw), bodySha256: hash(body) },
  };
}

export async function collectWayback(seed: Extract<HistoricalSeed, { source: "wayback" }>, asOf: string, get = download): Promise<HistoricalDocument> {
  if (isMarketHost(seed.url)) throw new Error("Market hosts are excluded by the forecasting protocol");
  const original = new URL(seed.url);
  if (!["https:", "http:"].includes(original.protocol) || original.username || original.password ||
      original.hash || typeof seed.label !== "string" || !seed.label.trim()) throw new Error("Invalid archive seed");
  const params = new URLSearchParams({ url: seed.url, matchType: "exact", output: "json",
    to: anchorUtc(asOf).replace(/\D/g, "").slice(0, 14), fl: "timestamp,original,digest", limit: "-1" });
  params.append("filter", "statuscode:200"); params.append("filter", "mimetype:text/html");
  const cdx = await get(`https://web.archive.org/cdx/search/cdx?${params}`);
  const rows = JSON.parse(cdx.text);
  if (!Array.isArray(rows) || rows.length !== 2 || JSON.stringify(rows[0]) !== JSON.stringify(["timestamp", "original", "digest"])) {
    throw new Error("No unique pre-anchor archive capture");
  }
  const [stamp, foundUrl] = rows[1];
  if (foundUrl !== seed.url || captureUtc(stamp) >= anchorUtc(asOf)) throw new Error("Archive capture URL/time mismatch");
  const url = `https://web.archive.org/web/${stamp}id_/${seed.url}`;
  const response = await get(url);
  const memento = Date.parse(response.headers.get("memento-datetime") ?? "");
  if (memento !== Date.parse(captureUtc(stamp))) throw new Error("Archive replay is not the requested capture");
  if (!/^text\/html(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("Archive payload is not HTML");
  const body = archivedHtmlText(response.text);
  if (!body) throw new Error("Empty archived HTML");
  // Store the CDX record and response together; CDX digest is provenance, not a verified body hash.
  const raw = JSON.stringify({ cdx: JSON.parse(cdx.text), mementoDatetime: response.headers.get("memento-datetime"), html: response.text });
  return { title: seed.label, url, originalUrl: seed.url, body, raw,
    evidence: { kind: "wayback-capture", version: stamp, availableAt: captureUtc(stamp), acquiredAt: new Date().toISOString(),
      rawSha256: hash(raw), bodySha256: hash(body) } };
}
