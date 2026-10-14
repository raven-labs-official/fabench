import test from "node:test";
import assert from "node:assert/strict";
import { BraveSearchProvider, createSearchProvider, BRAVE_SEARCH_CONFIG, braveHttpError } from "./search-providers.js";

test('Brave monthly spending limit is distinct from rate throttling and keeps sanitized evidence',()=>{
  // Fields from the real September 16 readiness response; no account credentials.
  const error=braveHttpError(402,JSON.stringify({type:'ErrorResponse',error:{status:402,
    detail:'Usage limit exceeded.',code:'USAGE_LIMIT_EXCEEDED',meta:{current_spend:15.01,usage_limit:15,usage_limit_type:'monthly'},ignored:'private'}}),'test-key');
  assert.equal(error.category,'insufficient_balance');assert.equal(error.retryable,false);
  assert.equal(error.providerCode,'USAGE_LIMIT_EXCEEDED');assert.match(error.message,/usage_limit=15, current_spend=15.01/);
  assert.doesNotMatch(error.message,/private/);
  assert.doesNotMatch(braveHttpError(401,JSON.stringify({error:{detail:'x'.repeat(390)+'test-key'}}),'test-key').message,/test-key/);
});
import { providerDateCutoff } from "./search-backend.js";

test("Explicit Brave selection only needs its API key and does not change auto selection", () => {
  assert.equal(createSearchProvider("brave", { BRAVE_API_KEY: "synthetic" }).name, "brave");
  assert.equal(createSearchProvider("auto", { SERPER_API_KEY: "synthetic", BRAVE_API_KEY: "synthetic" }).name, "serper");
  assert.throws(() => createSearchProvider("brave", {}), /API key is not set/);
  assert.throws(() => createSearchProvider("auto", { BRAVE_API_KEY: "synthetic" }), /explicit --search-provider brave/);
  assert.throws(() => createSearchProvider("missing", {}), /brave/);
});

test("Brave sends an inclusive calendar range, keeps the key in headers, and returns dated extra snippets", async t => {
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, BRAVE_SEARCH_CONFIG.endpoint);
    assert.equal(u.searchParams.get("q"), "Federal Reserve & CPI #2026");
    assert.equal(u.searchParams.get("freshness"), "1970-01-01to2026-03-01");
    assert.equal(u.searchParams.get("count"), "20");
    assert.equal(u.searchParams.get("extra_snippets"), "true");
    assert.equal(u.searchParams.get("spellcheck"), "false");
    assert.equal(url.includes("synthetic-key"), false);
    assert.equal(new Headers(options.headers).get("x-subscription-token"), "synthetic-key");
    assert.equal(options.redirect, "error");
    return Response.json({ web: { results: [
      { url: "https://example.test/a", title: "A", description: "first", extra_snippets: ["first", "second", null], page_age: "2026-02-28T12:00:00Z" },
      { url: "https://example.test/b", age: "2 days ago", page_fetched: "2026-02-27" },
      { url: "javascript:alert(1)" },
    ] } });
  });
  const provider = new BraveSearchProvider("synthetic-key");
  const hits = await provider.search("Federal Reserve & CPI #2026", 40, "2026-03-01");
  assert.equal(hits.length, 2); assert.equal(hits[0]!.snippet, "first\nsecond");
  assert.equal(hits[0]!.date, "2026-02-28T12:00:00Z"); assert.equal(hits[1]!.date, undefined);
  assert.deepEqual(provider.stats(), { requests: 1, failed: 0 });
});

test("A midnight runner cutoff uses the previous day at Brave's day precision", async t => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(new URL(url).searchParams.get("freshness"), "1970-01-01to2026-02-28");
    return Response.json({ type: "search", web: null });
  });
  const provider = new BraveSearchProvider("synthetic");
  assert.deepEqual(await provider.search("policy", 10, providerDateCutoff("2026-03-01T00:00:00Z")), []);
});

test("Brave supports ordinary undated queries but rejects malformed anchors before requesting", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls++; assert.equal(new URL(url).searchParams.has("freshness"), false);
    return Response.json({ type: "search" });
  });
  const provider = new BraveSearchProvider("synthetic");
  await provider.search("policy", 1);
  for (const asOf of ["2026-02-30", "bad", "1960-01-01"]) await assert.rejects(provider.search("policy", 10, asOf));
  await assert.rejects(provider.search("policy", NaN));
  await assert.rejects(provider.search("x".repeat(601), 1));
  await assert.rejects(provider.search(Array(76).fill("a").join(" "), 1));
  assert.equal(calls, 1);
});

test("Brave counts HTTP, network, invalid JSON and schema failures, without leaking error payloads", async t => {
  const provider = new BraveSearchProvider("synthetic-secret");
  const replies = [
    () => new Response("synthetic-secret", { status: 429 }),
    () => { throw new TypeError("synthetic-secret"); },
    () => new Response("not JSON"),
    () => Response.json({ web: { results: "invalid" } }),
    () => Response.json({ error: "synthetic-secret" }),
    () => Response.json({}),
  ];
  t.mock.method(globalThis, "fetch", async () => replies.shift()!());
  for (let i = 0; i < 6; i++) await assert.rejects(provider.search("policy", 10), error =>
    error instanceof Error && error.message.startsWith("brave ") && !error.message.includes("synthetic-secret"));
  assert.deepEqual(provider.stats(), { requests: 6, failed: 6 });
});

test("Brave shares the existing concurrency budget", async t => {
  let active = 0, peak = 0;
  t.mock.method(globalThis, "fetch", async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return Response.json({ type: "search" });
  });
  const provider = new BraveSearchProvider("synthetic");
  await Promise.all(Array.from({ length: 40 }, () => provider.search("policy", 1)));
  assert.ok(peak <= Number(process.env.SEARCH_CONCURRENCY ?? 16));
  assert.deepEqual(provider.stats(), { requests: 40, failed: 0 });
});
