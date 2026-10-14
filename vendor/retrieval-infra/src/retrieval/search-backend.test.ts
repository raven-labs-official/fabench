import assert from "node:assert/strict";
import test from "node:test";
import { LeakFilter } from "./leak-filter.js";
import type { PageDater } from "./page-dater.js";
import {
  isRetrievalInfrastructureError,
  RetrievalInfrastructureError,
} from "./infrastructure-error.js";
import {
  pageDateProvablyBeforeAnchor,
  providerDateCutoff,
  WebSearchBackend,
} from "./search-backend.js";
import type { SearchProvider } from "./search-providers.js";

const passLeakFilter = {
  stats: {
    scanned: 0,
    reviewed: 0,
    dropped: 0,
    reviewFailed: 0,
    fallbackUsed: 0,
    fallbackSucceeded: 0,
    fallbackFailed: 0,
    cacheHits: 0,
    peakReviewConcurrency: 0,
    costUsd: 0,
  },
  snapshot() {
    return { ...this.stats };
  },
  async filter(items: unknown[]) {
    return items;
  },
  async filterWithTrace(items: unknown[]) {
    return {
      items,
      trace: {
        scanned: items.length,
        reviewed: 0,
        reviewAttempts: 0,
        dropped: 0,
        cacheHits: 0,
        costUsd: 0,
        decisions: (items as { url: string; title: string; body?: string }[]).map((item) => ({
          url: item.url,
          title: item.title,
          bodySha256: "a".repeat(64),
          bodyChars: item.body?.length ?? 0,
          reviewedChars: item.body?.length ?? 0,
          reviewTruncated: false,
          suspicion: "fixture",
          leaked: false,
          reason: "fixture",
          evidenceQuoteVerified: false,
          verdict: { leaked: false, reason: "fixture" },
          reviewed: false,
          reviewAttempts: 0,
          cacheHit: false,
          costUsd: 0,
        })),
      },
    };
  },
  async check() {
    return { leaked: false, reason: "fixture" };
  },
  async checkWithTrace(url: string, title: string, body: string) {
    return {
      url,
      title,
      bodySha256: "a".repeat(64),
      bodyChars: body.length,
      reviewedChars: body.length,
      reviewTruncated: false,
      suspicion: "fixture",
      leaked: false,
      reason: "fixture",
      evidenceQuoteVerified: false,
      verdict: { leaked: false, reason: "fixture" },
      reviewed: false,
      reviewAttempts: 0,
      cacheHit: false,
      costUsd: 0,
    };
  },
} as unknown as LeakFilter;

test("WebSearchBackend opens after consecutive provider failures", async () => {
  let requests = 0;
  const provider: SearchProvider = {
    name: "fixture",
    async search() {
      requests++;
      throw new Error("quota exhausted");
    },
    stats: () => ({ requests, failed: requests }),
  };
  const dater = { fetchMany: async () => [] } as unknown as PageDater;
  const backend = new WebSearchBackend(provider, dater, passLeakFilter, {
    maxConsecutiveSearchFailures: 2,
    maxConsecutiveZeroServed: 5,
  });

  assert.deepEqual(await backend.search("first", 10, "2026-01-01"), []);
  await assert.rejects(
    backend.search("second", 10, "2026-01-01"),
    (error: unknown) =>
      isRetrievalInfrastructureError(error) &&
      error.component === "search-provider" &&
      error.code === "consecutive_failures",
  );
  assert.equal(backend.stats().circuit_open, 1);
});

test("one leak reviewer failure stays cell-scoped and does not poison the shared backend", async () => {
  const provider: SearchProvider = {
    name: "fixture",
    async search() {
      return [{ url: "https://example.test/article", title: "article" }];
    },
    stats: () => ({ requests: 2, failed: 0 }),
  };
  const dater = {
    async fetchMany() {
      return [{
        url: "https://example.test/article",
        title: "article",
        text: "known before cutoff",
        date: "2025-12-31",
        why: "",
      }];
    },
  } as unknown as PageDater;
  let batches = 0;
  const leak = {
    async filterWithTrace(docs: unknown[]) {
      batches++;
      if (batches === 1)
        throw new RetrievalInfrastructureError(
          "leak-filter",
          "review_failed",
          "fallback also unavailable",
        );
      return {
        items: docs,
        trace: {
          scanned: docs.length,
          reviewed: docs.length,
          reviewAttempts: docs.length,
          fallbackUsed: 0,
          dropped: 0,
          cacheHits: 0,
          costUsd: 0,
          decisions: [],
        },
      };
    },
  } as unknown as LeakFilter;
  const backend = new WebSearchBackend(provider, dater, leak);

  await assert.rejects(
    backend.search("first cell", 1, "2026-01-02"),
    (error: unknown) =>
      isRetrievalInfrastructureError(error) &&
      error.component === "leak-filter",
  );
  assert.equal(backend.stats().circuit_open, 0);
  assert.equal((await backend.search("next cell", 1, "2026-01-02")).length, 1);
});

test("providerDateCutoff does not give date-only providers the day after a midnight anchor", () => {
  assert.equal(providerDateCutoff("2026-03-01T00:00:00Z"), "2026-02-28");
  assert.equal(providerDateCutoff("2026-03-25T22:06:55Z"), "2026-03-25");
  assert.equal(providerDateCutoff("2026-03-01"), "2026-03-01");
});

test("pageDateProvablyBeforeAnchor rejects ambiguous same-day pages for exact anchors", () => {
  assert.equal(pageDateProvablyBeforeAnchor("2026-02-28", "2026-03-01T00:00:00Z"), true);
  assert.equal(pageDateProvablyBeforeAnchor("2026-03-01", "2026-03-01T00:00:00Z"), false);
  assert.equal(pageDateProvablyBeforeAnchor("2026-03-24", "2026-03-25T22:06:55Z"), true);
  assert.equal(pageDateProvablyBeforeAnchor("2026-03-25", "2026-03-25T22:06:55Z"), false);
  assert.equal(pageDateProvablyBeforeAnchor("2026-03-01", "2026-03-01"), true);
});

test("WebSearchBackend sends the safe provider cutoff and counts ambiguous same-day drops", async () => {
  let actualCutoff: string | undefined;
  const provider: SearchProvider = {
    name: "fixture",
    async search(_query, _n, asOf) {
      actualCutoff = asOf;
      return [{ url: "https://example.test/same-day", title: "same day" }];
    },
    stats: () => ({ requests: 1, failed: 0 }),
  };
  const dater = {
    async fetchMany(urls: string[]) {
      return urls.map((url) => ({
        url,
        date: "2026-03-01",
        title: "same day",
        text: "body",
        why: "",
      }));
    },
  } as unknown as PageDater;
  const backend = new WebSearchBackend(provider, dater, passLeakFilter);

  const searched = await backend.searchWithTrace(
    "fixture",
    10,
    "2026-03-01T00:00:00Z",
  );
  assert.equal(actualCutoff, "2026-02-28");
  assert.equal(searched.results.length, 0);
  assert.equal(searched.funnel.pages_same_day_rejected, 1);
  assert.equal(searched.funnel.pages_post_anchor_or_invalid, 1);
});

test("WebSearchBackend treats repeated legitimate zero-served searches as warnings", async () => {
  let requests = 0;
  const provider: SearchProvider = {
    name: "fixture",
    async search() {
      requests++;
      return [{ url: `https://example.test/${requests}`, title: "fixture" }];
    },
    stats: () => ({ requests, failed: 0 }),
  };
  const dater = {
    async fetchMany(urls: string[]) {
      return urls.map((url) => ({
        url,
        date: null,
        title: "",
        text: "",
        why: "no date in page",
      }));
    },
  } as unknown as PageDater;
  const backend = new WebSearchBackend(provider, dater, passLeakFilter, {
    maxConsecutiveSearchFailures: 3,
    maxConsecutiveZeroServed: 2,
  });

  for (let i = 0; i < 6; i++)
    assert.deepEqual(await backend.search(`absence query ${i}`, 10, "2026-01-01"), []);
  assert.equal(backend.stats().circuit_open, 0);
  assert.equal(backend.stats().max_consecutive_zero_served_observed, 6);
  assert.equal(backend.stats().zero_served_warnings, 3);
});

test("WebSearchBackend exposes the filtering funnel for every successful search", async () => {
  let requests = 0;
  const provider: SearchProvider = {
    name: "fixture",
    async search() {
      requests++;
      return [
        { url: "https://example.test/old", title: "old" },
        { url: "https://example.test/new", title: "new", date: "2026-02-01" },
        { url: "https://example.test/undated", title: "undated" },
      ];
    },
    stats: () => ({ requests, failed: 0 }),
  };
  const dater = {
    async fetchMany(urls: string[]) {
      return urls.map((url) =>
        url.endsWith("old")
          ? { url, date: "2025-12-31", title: "old", text: "body", why: "" }
          : { url, date: null, title: "", text: "", why: "no date in page" },
      );
    },
  } as unknown as PageDater;
  const backend = new WebSearchBackend(provider, dater, passLeakFilter, {
    maxConsecutiveSearchFailures: 3,
    maxConsecutiveZeroServed: 5,
  });

  const searched = await backend.searchWithTrace("fixture", 10, "2026-01-01");
  assert.equal(searched.results.length, 1);
  assert.deepEqual(searched.funnel, {
    backend: "web-filter",
    provider: "fixture",
    anchor_utc: "2026-01-01",
    provider_date_cutoff: "2026-01-01",
    page_date_policy: "date-only-inclusive",
    provider_failed: false,
    requested_results: 10,
    provider_hits: 3,
    engine_date_dropped: 1,
    engine_same_day_rejected: 0,
    candidates_to_page_dater: 2,
    page_records: 2,
    pages_dated_pre_anchor: 1,
    pages_undated: 1,
    pages_post_anchor_or_invalid: 0,
    pages_same_day_rejected: 0,
    pages_blocked_with_snippet: 0,
    market_hosts_blocked: 0,
    leak_reviews: 0,
    leak_review_attempts: 0,
    leak_dropped: 0,
    uncertainty_dropped: 0,
    temporal_dropped: 0,
    leak_cache_hits: 0,
    leak_review_failed: 0,
    leak_cost_usd: 0,
    served: 1,
  });
  assert.equal(searched.audit?.schema_version, "raven.retrieval-audit.v1");
  assert.deepEqual(
    searched.audit?.candidates.map((candidate) => candidate.final_disposition),
    ["served_to_forecaster", "engine_date_rejected", "fetch_undated_or_blocked"],
  );
  assert.equal(searched.audit?.candidates[0]?.fetch?.body, "body");
  assert.equal(searched.audit?.candidates[0]?.leak_filter?.reason, "fixture");
});

test("WebSearchBackend does not treat a genuinely empty provider result as failure", async () => {
  let requests = 0;
  const provider: SearchProvider = {
    name: "fixture",
    async search() {
      requests++;
      return [];
    },
    stats: () => ({ requests, failed: 0 }),
  };
  const dater = { fetchMany: async () => [] } as unknown as PageDater;
  const backend = new WebSearchBackend(provider, dater, passLeakFilter, {
    maxConsecutiveSearchFailures: 2,
    maxConsecutiveZeroServed: 2,
  });

  assert.deepEqual(await backend.search("first", 10, "2026-01-01"), []);
  assert.deepEqual(await backend.search("second", 10, "2026-01-01"), []);
  assert.equal(backend.stats().circuit_open, 0);
});

test("date-gate content routes undated and post-anchor pages to the content reviewer", async () => {
  // One page of each kind: dated before the anchor (admitted in both modes), dated after the
  // anchor, and undated with a body. The fourth has no body at all and must be dropped in both
  // modes: the content judge is not a path for "unknown, let it through".
  const provider: SearchProvider = {
    name: "fixture",
    async search() {
      return [
        { url: "https://example.test/pre", title: "pre" },
        { url: "https://example.test/post", title: "post" },
        { url: "https://example.test/undated", title: "undated" },
        { url: "https://example.test/empty", title: "empty" },
      ];
    },
    stats: () => ({ requests: 1, failed: 0 }),
  };
  const dater = {
    async fetchMany(urls: string[]) {
      return urls.map((url) =>
        url.endsWith("pre")
          ? { url, date: "2025-12-31", title: "pre", text: "pre body", why: "" }
          : url.endsWith("post")
            ? { url, date: "2026-02-01", title: "post", text: "post body", why: "" }
            : url.endsWith("undated")
              ? { url, date: null, title: "undated", text: "undated body", why: "no date in page" }
              : { url, date: null, title: "empty", text: "", why: "HTTP 403" },
      );
    },
  } as unknown as PageDater;
  const circuit = { maxConsecutiveSearchFailures: 3, maxConsecutiveZeroServed: 5 };

  const strict = new WebSearchBackend(provider, dater, passLeakFilter, circuit);
  const strictRun = await strict.searchWithTrace("fixture", 10, "2026-01-01");
  assert.deepEqual(
    strictRun.audit?.candidates.map((c) => c.final_disposition),
    [
      "served_to_forecaster",
      "page_date_rejected",
      "fetch_undated_or_blocked",
      "fetch_undated_or_blocked",
    ],
    "under strict only the page dated before the anchor is admitted",
  );
  assert.equal(strict.stats().content_cleared_undated, 0);
  assert.equal(strict.stats().content_cleared_postdate, 0);

  const content = new WebSearchBackend(provider, dater, passLeakFilter, circuit, "content");
  const contentRun = await content.searchWithTrace("fixture", 10, "2026-01-01");
  assert.deepEqual(
    contentRun.audit?.candidates.map((c) => c.final_disposition),
    [
      "served_to_forecaster",
      "content_cleared_postdate",
      "content_cleared_undated",
      // a page without a body is still dropped
      "fetch_undated_or_blocked",
    ],
    "under content the two pages admitted by the content judge keep their own dispositions, not served_to_forecaster",
  );
  assert.equal(contentRun.results.length, 3);
  assert.equal(contentRun.funnel.pages_dated_pre_anchor, 1);
  assert.equal(contentRun.funnel.pages_undated, 2);
  assert.equal(contentRun.funnel.pages_post_anchor_or_invalid, 1);
  assert.equal(content.stats().content_cleared_undated, 1);
  assert.equal(content.stats().content_cleared_postdate, 1);
  assert.equal(content.stats().date_gate_content_mode, 1);
  // "Failed the date gate" is counted the same way in both modes, or the two run summaries would not be comparable
  assert.equal(content.stats().after_anchor, strict.stats().after_anchor);
});

test("date-gate content still drops a page the content reviewer flags", async () => {
  const provider: SearchProvider = {
    name: "fixture",
    async search() {
      return [{ url: "https://example.test/undated", title: "undated" }];
    },
    stats: () => ({ requests: 1, failed: 0 }),
  };
  const dater = {
    async fetchMany(urls: string[]) {
      return urls.map((url) => ({
        url, date: null, title: "undated", text: "undated body", why: "no date in page",
      }));
    },
  } as unknown as PageDater;
  const dropAll = {
    ...passLeakFilter,
    async filterWithTrace(items: { url: string; title: string; body?: string }[]) {
      return {
        items: [],
        trace: {
          scanned: items.length, reviewed: items.length, reviewAttempts: items.length,
          dropped: items.length, cacheHits: 0, costUsd: 0,
          decisions: items.map((item) => ({
            url: item.url, title: item.title, bodySha256: "a".repeat(64),
            bodyChars: item.body?.length ?? 0, reviewedChars: item.body?.length ?? 0,
            reviewTruncated: false, suspicion: "fixture", leaked: true, reason: "fixture leak",
            evidenceQuoteVerified: false, verdict: { leaked: true, reason: "fixture leak" },
            reviewed: true, reviewAttempts: 1, cacheHit: false, costUsd: 0,
          })),
        },
      };
    },
  };
  const backend = new WebSearchBackend(
    provider, dater, dropAll as unknown as typeof passLeakFilter,
    { maxConsecutiveSearchFailures: 3, maxConsecutiveZeroServed: 5 }, "content",
  );
  const run = await backend.searchWithTrace("fixture", 10, "2026-01-01");
  assert.deepEqual(run.audit?.candidates.map((c) => c.final_disposition), ["leak_rejected"]);
  assert.equal(run.results.length, 0);
  assert.equal(backend.stats().content_cleared_undated, 0);
});

test("served_to_forecaster records what the model read, not how the page got in", async () => {
  // Regression test. This boolean used to be finalDisposition === "served_to_forecaster",
  // which became wrong once the two content_cleared_* dispositions were added: a document
  // admitted by the content judge **and actually given to the model** was recorded as
  // served=false, so audits undercounted deliveries without any visible error.
  // The disposition answers "how was it admitted"; this boolean answers "did the model actually read it".
  const provider: SearchProvider = {
    name: "fixture",
    async search() {
      return [
        { url: "https://example.test/pre", title: "pre" },
        { url: "https://example.test/undated", title: "undated" },
      ];
    },
    stats: () => ({ requests: 1, failed: 0 }),
  };
  const dater = {
    async fetchMany(urls: string[]) {
      return urls.map((url) =>
        url.endsWith("pre")
          ? { url, date: "2025-12-31", title: "pre", text: "pre body", why: "" }
          : { url, date: null, title: "undated", text: "undated body", why: "no date in page" },
      );
    },
  } as unknown as PageDater;
  const backend = new WebSearchBackend(
    provider, dater, passLeakFilter,
    { maxConsecutiveSearchFailures: 3, maxConsecutiveZeroServed: 5 }, "content",
  );
  const run = await backend.searchWithTrace("fixture", 10, "2026-01-01");
  assert.equal(run.results.length, 2, "both pages reach the model");
  const byUrl = new Map(run.audit!.candidates.map((c) => [c.url, c]));
  const undated = byUrl.get("https://example.test/undated")!;
  assert.equal(undated.final_disposition, "content_cleared_undated", "the disposition says how it was admitted");
  assert.equal(undated.served_to_forecaster, true, "the boolean says the model did read it");
  assert.equal(byUrl.get("https://example.test/pre")!.served_to_forecaster, true);
});


test("invalid calendar dates cannot pass the historical gate", () => {
  assert.equal(pageDateProvablyBeforeAnchor("2026-02-30", "2026-03-01"), false);
});

test("direct fetch of a market host is rejected before contacting the dater and audited", async () => {
  let calls = 0;
  const provider = { name: "fixture", search: async () => [], stats: () => ({requests:0,failed:0}) };
  const dater = { async fetchMany() { calls++; return []; } } as unknown as PageDater;
  const backend = new WebSearchBackend(provider, dater, passLeakFilter);
  const result = await backend.fetchWithTrace("https://polymarket.com/event/example", "2026-03-01");
  assert.equal(calls, 0);
  assert.equal(result.doc, null);
  assert.equal(result.audit?.candidates[0]?.final_disposition, "market_host_rejected");
});

test("v4 web search and direct fetch withhold uncertainty without counting it as confirmed leakage", async () => {
  const pages = [
    {url:"https://example.test/clean",title:"Old forecast",date:"2026-08-01",text:"Old forecast for a later day"},
    {url:"https://example.test/unknown",title:"Old article",date:"2026-08-01",text:"Undated live headline"},
    {url:"https://example.test/leak",title:"Old article",date:"2026-08-01",text:"Later final score"},
  ];
  const provider: SearchProvider = {name:"fixture",async search(){return pages;},stats:()=>({requests:1,failed:0})};
  const dater = {async fetchMany(urls:string[]){return pages.filter(p=>urls.includes(p.url));}} as unknown as PageDater;
  const filter = new LeakFilter({id:"fixture",async complete(request){
    const label = request.prompt.includes("TEXT:\nLater final score") ? "leaked"
      : request.prompt.includes("TEXT:\nUndated live headline") ? "unknown" : "clean";
    return {text:JSON.stringify({main:{label:"clean",reason:"old main"},ancillary:{label,reason:"separate issue time"},useful:true,
      evidence:label==="clean"?[]:[{area:"ancillary",label,quote:label==="leaked"?"Later final score":"Undated live headline",availability_basis:"test source"}]}),
      inputTokens:0,outputTokens:0,costUsd:0};
  }},{availabilityPolicy:"component-availability-v4",reviewAttempts:1});
  const backend = new WebSearchBackend(provider,dater,filter);
  const asOf = "2026-09-02T08:26:26Z";
  const result = await backend.searchWithTrace("fixture",3,asOf);
  assert.deepEqual(result.results.map(r=>r.url),[pages[0]!.url]);
  assert.deepEqual(result.audit?.candidates.map(c=>c.final_disposition),["served_to_forecaster","uncertainty_rejected","leak_rejected"]);
  assert.equal(result.funnel.leak_dropped,1);
  assert.equal(result.funnel.uncertainty_dropped,1);
  assert.equal(result.funnel.temporal_dropped,2);
  const fetched = await backend.fetchWithTrace(pages[1]!.url,asOf);
  assert.equal(fetched.doc,null);
  assert.equal(fetched.audit?.candidates[0]?.served_to_forecaster,false);
  assert.equal(fetched.audit?.candidates[0]?.final_disposition,"uncertainty_rejected");
  assert.equal(backend.stats().leak_withheld,1);
  assert.equal(backend.stats().uncertainty_withheld,2);
  assert.equal(backend.stats().temporal_withheld,3);
  const clean = await backend.fetchWithTrace(pages[0]!.url,asOf);
  assert.equal(clean.doc?.body,pages[0]!.text);
});
