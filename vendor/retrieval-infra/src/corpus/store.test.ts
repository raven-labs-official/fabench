/**
 * The core correctness guarantee of the frozen corpus: a search with cutoff
 * `asOf` must NEVER return a document captured after `asOf`. If this ever fails,
 * the benchmark is leaking future information and its scores are meaningless.
 *
 * Run: pnpm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CorpusStore } from "./store.js";

test("unknown metric identifiers are not erased to manufacture coverage", () => {
  const store = seed();
  try {
    assert.deepEqual(store.search('USEPUINDXD tariff negotiations', '2025-02-15'), []);
    assert.deepEqual(store.search('typoabcnotindexed', '2025-02-15'), []);
    assert.deepEqual(store.search('T5YIFR tariff negotiations', '2025-02-15'), []);
  } finally { store.close(); }
});

test("fetch selects the most recent pre-anchor revision and excludes later edits", () => {
  const store = new CorpusStore();
  try {
    for (const [day, body] of [['01', 'old'], ['10', 'new known information'], ['20', 'future outcome']]) {
      store.ingest([{ url: 'https://example.test/page', title: 'An update', body: body!, crawlDate: `2026-02-${day}T12:00:00Z` }]);
    }
    assert.equal(store.getByUrlBefore('https://example.test/page', '2026-02-15')?.body, 'new known information');
    assert.equal(store.earliestCrawlBefore('https://example.test/page', '2026-02-15'), '2026-02-01T12:00:00Z');
  } finally { store.close(); }
});

function seed(): CorpusStore {
  const store = new CorpusStore(":memory:");
  store.ingest([
    {
      url: "https://example.com/jan",
      title: "Tariff talks begin",
      body: "In January the tariff negotiations began between the two nations.",
      crawlDate: "2025-01-10T08:00:00Z",
    },
    {
      url: "https://example.com/feb",
      title: "Tariff deadline looms",
      body: "By February the tariff deadline was approaching with no deal in sight.",
      crawlDate: "2025-02-10T08:00:00Z",
    },
    {
      url: "https://example.com/mar",
      title: "Tariff deal signed",
      body: "In March a surprise tariff agreement was signed, resolving the dispute.",
      crawlDate: "2025-03-10T08:00:00Z",
    },
  ]);
  return store;
}

test("no leakage: cutoff before March excludes the March-crawled doc", () => {
  const store = seed();
  const hits = store.search("tariff", "2025-02-15", 10);
  const urls = hits.map((h) => h.url);
  assert.ok(urls.includes("https://example.com/jan"), "Jan doc should be found");
  assert.ok(urls.includes("https://example.com/feb"), "Feb doc should be found");
  assert.ok(
    !urls.includes("https://example.com/mar"),
    "March doc must NOT leak past a Feb cutoff",
  );
  store.close();
});

test("later cutoff includes all docs", () => {
  const store = seed();
  const hits = store.search("tariff", "2025-03-31", 10);
  assert.equal(hits.length, 3, "all three docs available after March");
  store.close();
});

test("date-only cutoff includes same-day crawls", () => {
  const store = seed();
  // March doc crawled 2025-03-10T08:00; a date-only cutoff of that day must include it.
  const hits = store.search("tariff", "2025-03-10", 10);
  assert.ok(
    hits.some((h) => h.url === "https://example.com/mar"),
    "same-day crawl must be included for a date-only cutoff",
  );
  store.close();
});

test("BM25 ranks the most on-topic doc first", () => {
  const store = seed();
  const hits = store.search("tariff deal signed agreement", "2025-03-31", 10);
  assert.equal(
    hits[0].url,
    "https://example.com/mar",
    "the doc mentioning 'deal/signed/agreement' should rank first",
  );
  store.close();
});

test("empty / punctuation-only query returns no hits, never throws", () => {
  const store = seed();
  assert.deepEqual(store.search("", "2025-03-31"), []);
  assert.deepEqual(store.search("!!! ??? ...", "2025-03-31"), []);
  store.close();
});

test("validateCitations: url present before cutoff is valid, after is not", () => {
  const store = seed();
  assert.equal(
    store.earliestCrawlBefore("https://example.com/mar", "2025-02-15"),
    null,
    "March url not yet captured by Feb cutoff",
  );
  assert.equal(
    store.earliestCrawlBefore("https://example.com/mar", "2025-03-31"),
    "2025-03-10T08:00:00Z",
    "March url captured by end of March",
  );
  store.close();
});
