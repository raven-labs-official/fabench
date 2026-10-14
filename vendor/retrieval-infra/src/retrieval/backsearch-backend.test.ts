import { test } from "node:test";
import assert from "node:assert/strict";
import { asOfParam, intradayCutoffMs, BackSearchBackend } from "./backsearch-backend.js";

/**
 * The anchor is a timestamp; BackSearch's `as_of` is a calendar day and inclusive. 216 of the
 * 300 questions carry a midnight anchor, so getting this wrong hands one arm an extra day of
 * crawling on 72% of the set — a silent, one-sided advantage that no downstream number reveals.
 */
test("midnight anchor maps to the previous day, so the interval matches the frozen corpus", () => {
  assert.equal(asOfParam("2026-03-01T00:00:00Z"), "2026-02-28");
  assert.equal(asOfParam("2026-03-01T00:00Z"), "2026-02-28");
});

test("an intraday anchor keeps its own day, which is the inclusive day it falls in", () => {
  assert.equal(asOfParam("2026-03-21T11:55:23Z"), "2026-03-21");
});

test("a date-only anchor is already the day", () => {
  assert.equal(asOfParam("2026-03-21"), "2026-03-21");
});

test("an unparseable anchor throws rather than silently resolving to today", () => {
  assert.throws(() => asOfParam("not-a-date"), /unparseable anchor/);
});

import { MergeBackend } from "./search-backend.js";
import type { BackendDoc, BackendResult, SearchBackend } from "./search-backend.js";

class Fake implements SearchBackend {
  constructor(readonly name: string, private readonly hits: BackendResult[]) {}
  async search(): Promise<BackendResult[]> { return this.hits; }
  async fetch(): Promise<BackendDoc | null> { return null; }
  stats() { return { searches: 1 }; }
}
const hit = (url: string, title: string, source: string): BackendResult =>
  ({ url, title, snippet: "", source: source as BackendResult["source"] });

/**
 * Branch order is priority order, and that is the whole measurement: with the archive first,
 * whatever a later branch adds IS the archive's gap. If a later branch could displace an
 * earlier one, the merged arm would score better without anyone being able to say what it
 * had found that we lacked.
 */
test("later branches contribute only what earlier ones missed, keeping their own source", async () => {
  const m = new MergeBackend([
    new Fake("frozen", [hit("https://a", "Ceasefire extended", "frozen")]),
    new Fake("web", [
      hit("https://a", "Ceasefire extended", "web"),          // same url
      hit("https://b", "CEASEFIRE  EXTENDED!", "web"),        // same story, different outlet
      hit("https://c", "Talks open in Washington", "web"),    // genuinely new
    ]),
  ]);
  const out = await m.search("q", 10, "2026-03-01");
  assert.deepEqual(out.map((r) => r.url), ["https://a", "https://c"]);
  assert.deepEqual(out.map((r) => r.source), ["frozen", "web"]);
});

test("three branches merge, and stats stay attributed per branch", async () => {
  const m = new MergeBackend([
    new Fake("frozen", [hit("https://a", "A", "frozen")]),
    new Fake("web", [hit("https://b", "B", "web")]),
    new Fake("backsearch", [hit("https://c", "C", "backsearch")]),
  ]);
  assert.equal(m.name, "frozen+web+backsearch");
  assert.equal((await m.search("q", 10, "2026-03-01")).length, 3);
  const st = m.stats();
  assert.equal(st.frozen_searches, 1);
  assert.equal(st.backsearch_searches, 1);
  assert.ok("backsearch_ms_avg" in st);
});

test("a merged backend needs at least two branches", () => {
  assert.throws(() => new MergeBackend([new Fake("frozen", [])]), /at least two/);
});


/**
 * The three conditions that kept this arm out of formal runs. Each one failed silently: an
 * undated hit passed the date gate, a whole-article fetch returned an empty string, and a
 * same-day capture cleared an intraday anchor. None of them raised an error, and none of them
 * is visible in a Brier score — which is why they are pinned here rather than left to review.
 */

// ---- blocker 1: an undated hit must not pass the gate ----------------------------------

test("a hit with no crawl_date is dropped, not admitted", () => {
  const b = new BackSearchBackend({ apiKey: "x" });
  const gate = (b as unknown as { gate: Function }).gate.bind(b);
  const kept = gate(
    [{ url: "a", crawl_date: "2026-02-20" }, { url: "b" }, { url: "c", crawl_date: "" }],
    "2026-02-28",
    0,
    "q",
  );
  assert.deepEqual(kept.map((h: { url: string }) => h.url), ["a"]);
  assert.equal(b.stats().dropped_undated, 2);
});

test("a hit dated after the cutoff still voids the run", () => {
  const b = new BackSearchBackend({ apiKey: "x" });
  const gate = (b as unknown as { gate: Function }).gate.bind(b);
  assert.throws(
    () => gate([{ url: "a", crawl_date: "2026-03-05" }], "2026-02-28", 0, "q"),
    /post-anchor document/,
  );
});

// ---- blocker 2: fetchChars 0 means the whole article, not nothing -----------------------

test("fetchChars 0 keeps the whole article; absent falls back to 4000", () => {
  const whole = new BackSearchBackend({ apiKey: "x", fetchChars: 0 });
  const capped = new BackSearchBackend({ apiKey: "x" });
  const limit = (b: BackSearchBackend) => (b as unknown as { maxFetchChars: number }).maxFetchChars;
  assert.equal(limit(whole), 0);
  assert.equal(limit(capped), 4000);
});

// ---- blocker 3: day-granularity as_of cannot clear an intraday anchor -------------------

test("only an intraday anchor needs a second cutoff", () => {
  assert.equal(intradayCutoffMs("2026-03-01T00:00:00Z"), 0);
  assert.equal(intradayCutoffMs("2026-03-21"), 0);
  assert.equal(intradayCutoffMs("2026-03-21T11:55:23Z"), Date.parse("2026-03-21T11:55:23Z"));
});

test("under an intraday anchor, a same-day capture is admitted only if its time proves it", () => {
  const b = new BackSearchBackend({ apiKey: "x" });
  const gate = (b as unknown as { gate: Function }).gate.bind(b);
  const cutoff = intradayCutoffMs("2026-03-21T11:55:23Z");
  const kept = gate(
    [
      { url: "before", crawl_date: "2026-03-21T09:00:00Z" },
      { url: "after", crawl_date: "2026-03-21T23:00:00Z" },
      { url: "date-only-same-day", crawl_date: "2026-03-21" },
      { url: "date-only-earlier-day", crawl_date: "2026-03-20" },
    ],
    "2026-03-21",
    cutoff,
    "q",
  );
  assert.deepEqual(kept.map((h: { url: string }) => h.url), ["before", "date-only-earlier-day"]);
  assert.equal(b.stats().dropped_after_intraday_anchor, 2);
});
