import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isMarketHost } from "../retrieval/market-blocklist.js";

export const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Match the runner's inclusive UTC calendar-day convention; exact times need a zone. */
export function anchorUtc(value: string): string {
  const exact = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(exact)) {
    throw new Error(`Expected UTC date or timestamp: ${value}`);
  }
  const date = new Date(exact);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== exact.slice(0, 10)) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return date.toISOString();
}

export function captureUtc(stamp: string): string {
  if (!/^\d{14}$/.test(stamp)) throw new Error("Invalid archive timestamp");
  return anchorUtc(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`);
}

/** Deterministic text only: no scripts, linked pages, images, or replay UI are loaded. */
export function archivedHtmlText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ").trim();
}

export interface HistoricalEvidence {
  kind: "wikipedia-revision" | "wayback-capture";
  version: string;
  availableAt: string;
  acquiredAt: string;
  rawSha256: string;
  bodySha256: string;
}

export interface HistoricalDocument {
  title: string;
  url: string;
  originalUrl: string;
  body: string;
  evidence: HistoricalEvidence;
  /** Exact decoded upstream response, archived for inspection; never served to the agent. */
  raw: string;
}

export interface HistoricalSnapshot {
  schema: "raven.historical-snapshot.v1";
  asOf: string;
  selection: string;
  planSha256: string;
  documents: HistoricalDocument[];
}

export function validateSnapshot(value: unknown): HistoricalSnapshot {
  const s = value as HistoricalSnapshot;
  if (!s || s.schema !== "raven.historical-snapshot.v1" || typeof s.asOf !== "string" ||
      typeof s.selection !== "string" || !s.selection.trim() ||
      !/^[a-f0-9]{64}$/.test(s.planSha256) || !Array.isArray(s.documents) || !s.documents.length) {
    throw new Error("Invalid or empty historical snapshot");
  }
  const cutoff = anchorUtc(s.asOf);
  const seen = new Set<string>();
  for (const d of s.documents) {
    if (!d || typeof d.title !== "string" || !d.title.trim() || typeof d.body !== "string" ||
        !d.body.trim() || typeof d.raw !== "string" || !d.evidence) throw new Error("Invalid historical document");
    const e = d.evidence;
    if (typeof e.availableAt !== "string" || typeof e.acquiredAt !== "string" ||
        !e.availableAt.includes("T") || !e.acquiredAt.includes("T") ||
        anchorUtc(e.availableAt) >= cutoff || anchorUtc(e.availableAt) > anchorUtc(e.acquiredAt)) {
      throw new Error("Historical document has missing, future, or inconsistent time evidence");
    }
    if (hash(d.raw) !== e.rawSha256 || hash(d.body) !== e.bodySha256) throw new Error("Historical content hash mismatch");
    const original = new URL(d.originalUrl);
    if (isMarketHost(d.originalUrl)) throw new Error("Market hosts are excluded by the forecasting protocol");
    if (!["http:", "https:"].includes(original.protocol) || original.username || original.password) throw new Error("Invalid original URL");
    const raw = JSON.parse(d.raw);
    if (e.kind === "wikipedia-revision") {
      const revision = raw.query?.pages?.[0]?.revisions?.[0];
      if (String(revision?.revid) !== e.version || revision?.timestamp !== e.availableAt ||
          revision?.slots?.main?.content !== d.body ||
          revision?.slots?.main?.contentmodel !== "wikitext" || /^\s*#redirect\b/i.test(d.body) ||
          createHash("sha1").update(d.body).digest("hex") !== (revision?.slots?.main?.sha1 ?? revision?.sha1)) {
        throw new Error("Wikipedia provenance does not match archived response");
      }
      if (!/^https:\/\/[a-z-]+\.wikipedia\.org\/w\/index\.php\?oldid=\d+$/.test(d.url) ||
          new URL(d.url).searchParams.get("oldid") !== e.version) throw new Error("Invalid Wikipedia version URL");
    } else if (e.kind === "wayback-capture") {
      if (captureUtc(e.version) !== anchorUtc(e.availableAt) || raw.cdx?.[1]?.[0] !== e.version ||
          raw.cdx?.[1]?.[1] !== d.originalUrl || Date.parse(raw.mementoDatetime) !== Date.parse(e.availableAt) ||
          typeof raw.html !== "string" || archivedHtmlText(raw.html) !== d.body) {
        throw new Error("Wayback provenance does not match archived response");
      }
      if (!/^\d{14}$/.test(e.version) || d.url !== `https://web.archive.org/web/${e.version}id_/${d.originalUrl}`) {
        throw new Error("Invalid Wayback capture URL");
      }
    } else throw new Error("Unsupported historical evidence kind");
    if (seen.has(d.url) || seen.has(d.originalUrl)) throw new Error("Duplicate historical URL");
    seen.add(d.url); seen.add(d.originalUrl);
  }
  return s;
}

export function loadHistoricalSnapshot(path: string) {
  const raw = readFileSync(path, "utf8");
  return { snapshot: validateSnapshot(JSON.parse(raw)), sha256: hash(raw) };
}
