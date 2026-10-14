import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectWikipedia, collectWayback, type Downloader } from "./historical-adapters.js";
import { anchorUtc, hash, loadHistoricalSnapshot, validateSnapshot, type HistoricalSnapshot } from "./historical-snapshot.js";
import { HistoricalBackend } from "../retrieval/historical-backend.js";
import { readWikipediaHistory } from "./wikipedia-history.js";

// Synthetic fixtures only. No network calls, model calls, or real evaluation evidence.
const asOf = "2026-03-01T00:00:00Z";
const body = "Federal Reserve interest policy before March. {{Current template}}";
const revision = (text = body, time = "2026-02-12T10:35:16Z") => JSON.stringify({ query: { pages: [{
  title: "FUTURE PAGE RENAME", revisions: [{ revid: 42, timestamp: time,
    sha1: createHash("sha1").update(text).digest("hex"), slots: { main: { contentmodel: "wikitext", content: text } } }],
}] } });
const getWiki: Downloader = async url => {
  const u = new URL(url);
  assert.equal(u.searchParams.get("rvstart"), anchorUtc(asOf));
  assert.equal(u.searchParams.get("rvdir"), "older");
  assert.equal(u.searchParams.get("redirects"), null);
  return { text: revision(), headers: new Headers() };
};
const seed = { source: "wikipedia", language: "en", title: "Federal Reserve" } as const;
const snapshot = async (): Promise<HistoricalSnapshot> => ({ schema: "raven.historical-snapshot.v1", asOf,
  selection: "Synthetic unit-test fixture", planSha256: hash("synthetic-plan"),
  documents: [await collectWikipedia(seed, asOf, getWiki)] });

test("Wikipedia uses exact older revision content and a predeclared title", async () => {
  const doc = await collectWikipedia(seed, asOf, getWiki);
  assert.equal(doc.title, "Federal Reserve");
  assert.equal(doc.body, body);
  assert.equal(doc.url, "https://en.wikipedia.org/w/index.php?oldid=42");
  assert.equal(doc.evidence.availableAt, "2026-02-12T10:35:16Z");
  assert.equal(doc.evidence.rawSha256, hash(doc.raw));
});

test("On-demand Wikipedia reads expose the chosen historical body with explicit truncation", async () => {
  const short = await readWikipediaHistory(seed.title, asOf, "en", 12, getWiki);
  assert.equal(short.text, body.slice(0, 12));
  assert.equal(short.truncated, true); assert.equal(short.fullBodyChars, body.length);
  assert.equal(short.evidence.bodySha256, hash(body));
  assert.equal("raw" in short, false);
  const full = await readWikipediaHistory(seed.title, asOf, "en", 0, getWiki);
  assert.equal(full.text, body); assert.equal(full.truncated, false);
  await assert.rejects(readWikipediaHistory(seed.title, asOf, "en", -1, getWiki));
});

test("Wikipedia refuses future, missing, hidden, redirects, and corrupt revision content", async () => {
  for (const text of [revision(body, "2026-03-02T00:00:00Z"), revision(body, asOf), "{}", revision("#REDIRECT [[Future target]]"),
    revision().replace(body, "changed body"), JSON.stringify({ query: { pages: [{ missing: true }] } })]) {
    await assert.rejects(collectWikipedia(seed, asOf, async () => ({ text, headers: new Headers() })));
  }
});

const capture = "20260223183544";
const originalUrl = "https://www.federalreserve.gov/";
const getArchive = (memento = "Mon, 23 Feb 2026 18:35:44 GMT", url = originalUrl): Downloader => async request => {
  if (request.includes("/cdx/")) {
    assert.equal(new URL(request).searchParams.get("to"), "20260301000000");
    return { text: JSON.stringify([["timestamp", "original", "digest"], [capture, url, "upstream-digest"]]), headers: new Headers() };
  }
  assert.equal(request, `https://web.archive.org/web/${capture}id_/${originalUrl}`);
  return { text: '<html><script>FUTURE_SCRIPT</script><p>Federal Reserve old policy</p></html>',
    headers: new Headers({ "memento-datetime": memento, "content-type": "text/html; charset=UTF-8" }) };
};
test("Wayback verifies exact capture and serves text without executing or following resources", async () => {
  const doc = await collectWayback({ source: "wayback", url: originalUrl, label: "Federal Reserve" }, asOf, getArchive());
  assert.equal(doc.body, "Federal Reserve old policy");
  assert.equal(doc.evidence.availableAt, "2026-02-23T18:35:44.000Z");
});
test("Wayback refuses nearest-capture fallback, missing timestamp, and URL mismatch", async () => {
  for (const get of [getArchive("Tue, 24 Feb 2026 18:35:44 GMT"), getArchive(""), getArchive(undefined, "https://other.example/")]) {
    await assert.rejects(collectWayback({ source: "wayback", url: originalUrl, label: "Federal Reserve" }, asOf, get));
  }
});

test("Market archives cannot bypass the existing domain exclusion", async () => {
  let requested = false;
  await assert.rejects(collectWayback({ source: "wayback", url: "https://polymarket.com/event/synthetic", label: "fixture" }, asOf,
    async () => { requested = true; throw new Error("Must not request"); }), /Market hosts/);
  assert.equal(requested, false);
});

test("Snapshot refuses post-anchor index members, corrupted text, duplicates and unknown proof kinds", async () => {
  for (const mutate of [
    (s: HistoricalSnapshot) => { s.documents[0]!.evidence.availableAt = "2026-03-02T00:00:00Z"; },
    (s: HistoricalSnapshot) => { s.documents[0]!.evidence.availableAt = asOf; },
    (s: HistoricalSnapshot) => { s.documents[0]!.body += " altered"; },
    (s: HistoricalSnapshot) => { s.documents.push(s.documents[0]!); },
    (s: HistoricalSnapshot) => { (s.documents[0]!.evidence as any).kind = "self-reported-publish-date"; },
  ]) {
    const s = await snapshot(); mutate(s); assert.throws(() => validateSnapshot(s));
  }
});

test("Backend is offline, exact-anchor, version-URL-only, and unaffected by caller mutations", async () => {
  const s = await snapshot();
  const backend = new HistoricalBackend(s);
  try {
    const hits = await backend.search("Federal Reserve", 1, asOf);
    assert.equal(hits.length, 1); assert.equal(hits[0]!.source, "historical");
    assert.equal(hits[0]!.crawlDate, undefined);
    assert.equal(hits[0]!.evidence!.kind, "wikipedia-revision");
    s.documents[0]!.body = "FUTURE CHANGE";
    assert.equal((await backend.fetch(hits[0]!.url, asOf))!.body, body);
    assert.equal(await backend.fetch(s.documents[0]!.originalUrl, asOf), null);
    await assert.rejects(backend.search("policy", 3, "2026-02-01"));
    await assert.rejects(backend.fetch(hits[0]!.url, "2026-03-02"));
    assert.deepEqual(await backend.search("the and", 10, asOf), []);
  } finally { backend.close(); }
});

test("Whole-file hash changes when source selection changes and reload catches corruption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "historical-snapshot-test-"));
  try {
    const s = await snapshot();
    const path = join(dir, "snapshot.json"); writeFileSync(path, JSON.stringify(s));
    const original = loadHistoricalSnapshot(path);
    s.selection = "Different seed selection"; writeFileSync(path, JSON.stringify(s));
    assert.notEqual(loadHistoricalSnapshot(path).sha256, original.sha256);
    s.documents[0]!.body += " bad"; writeFileSync(path, JSON.stringify(s));
    assert.throws(() => loadHistoricalSnapshot(path), /hash mismatch/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("Anchor parsing distinguishes an inclusive day from an exact instant", () => {
  assert.equal(anchorUtc("2026-03-01"), "2026-03-01T23:59:59.999Z");
  assert.notEqual(anchorUtc("2026-03-01"), anchorUtc(asOf));
  for (const date of ["2026-02-30", "2026-03-01T01:00:00", "not-a-date"]) assert.throws(() => anchorUtc(date));
});
