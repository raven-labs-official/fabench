import assert from "node:assert/strict";
import test from "node:test";
import type { LlmClient } from "../llm/client.js";
import { isRetrievalInfrastructureError } from "./infrastructure-error.js";
import { LeakFilter } from "./leak-filter.js";

test("live review cannot reuse a frozen cheap pass, or a differently titled page", async () => {
  let calls = 0;
  const filter = new LeakFilter({ id: 'fake:review', async complete() {
    calls++; return { ...cleanCompletion, text: '{"leaked":true,"reason":"settled later"}' };
  } }, { availabilityPolicy:"issued-information-v3", reviewAttempts: 1 });
  const args = ['https://example.test/page', 'Preview', 'An undated outcome', '2026-01-01'] as const;
  assert.equal((await filter.check(...args)).leaked, false);
  assert.equal((await filter.check(...args, { reviewAll: true })).leaked, true);
  await filter.check(args[0], 'Outcome declared', args[2], args[3], { reviewAll: true });
  assert.equal(calls, 2);
});

test("a future outcome after the old 40k limit is reviewed and withheld", async () => {
  let calls = 0;
  const filter = new LeakFilter({ id: 'fake:tail-review', async complete(request) {
    calls++;
    return { ...cleanCompletion, text: JSON.stringify({ leaked: request.prompt.includes('FINAL_OUTCOME'), reason: 'fixture' }) };
  } }, { availabilityPolicy:"issued-information-v3", reviewAttempts: 1, reviewChars: 40000 });
  const body = 'Background '.repeat(4000) + ' FINAL_OUTCOME';
  const trace = await filter.checkWithTrace('https://example.test/long', 'Preview', body, '2026-01-01', { reviewAll: true });
  assert.equal(calls, 2);
  assert.equal(trace.leaked, true);
  assert.equal(trace.reviewedChars, body.length);
  assert.equal(trace.reviewTruncated, false);
});

test("all clean passages survive and review failure in the tail is not cached", async () => {
  let broken = true;
  const filter = new LeakFilter({ id: 'fake:tail', async complete(request) {
    if (broken && request.prompt.includes('TAIL')) throw new Error('tail unavailable');
    return cleanCompletion;
  } }, { availabilityPolicy:"issued-information-v3", reviewAttempts: 1, reviewChars: 20 });
  const check = () => filter.checkWithTrace('https://example.test/long', 'Preview', 'A'.repeat(40) + 'TAIL', '2026-01-01', { reviewAll: true });
  await assert.rejects(check(), isRetrievalInfrastructureError);
  broken = false;
  const trace = await check();
  assert.equal(trace.leaked, false);
  assert.equal(trace.cacheHit, false);
  assert.equal(trace.reviewedChars, 44);
  assert.equal(trace.reviewTruncated, false);
});

const cleanCompletion = {
  text: '{"leaked":false,"reason":"known before the anchor"}',
  costUsd: 0.001,
  inputTokens: 10,
  outputTokens: 5,
};

test("LeakFilter enforces one run-wide review concurrency ceiling", async () => {
  let active = 0;
  let observedPeak = 0;
  const client: LlmClient = {
    id: "fake:filter",
    async complete() {
      active++;
      observedPeak = Math.max(observedPeak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return cleanCompletion;
    },
  };
  const filter = new LeakFilter(client, {
    availabilityPolicy:"issued-information-v3",
    reviewConcurrency: 3,
    reviewAttempts: 1,
    retryDelayMs: 0,
  });
  const batches = Array.from({ length: 8 }, (_, batch) =>
    Array.from({ length: 5 }, (_, item) => ({
      url: `https://example.test/${batch}/${item}`,
      title: "fixture",
      body: "fixture body",
    })),
  );

  const kept = await Promise.all(
    batches.map((docs) => filter.filter(docs, "2026-01-01", { reviewAll: true })),
  );

  assert.equal(kept.flat().length, 40);
  assert.equal(observedPeak, 3);
  assert.equal(filter.snapshot().peakReviewConcurrency, 3);
  assert.equal(filter.snapshot().reviewed, 40);
});

test("LeakFilter propagates and never caches reviewer failures as leak verdicts", async () => {
  let calls = 0;
  const client: LlmClient = {
    id: "fake:broken-filter",
    async complete() {
      calls++;
      throw new Error("429 reviewer unavailable");
    },
  };
  const filter = new LeakFilter(client, {
    availabilityPolicy:"issued-information-v3",
    reviewConcurrency: 2,
    reviewAttempts: 2,
    retryDelayMs: 0,
  });
  const check = () =>
    filter.check(
      "https://example.test/retry",
      "fixture",
      "fixture body",
      "2026-01-01",
      { reviewAll: true },
    );

  await assert.rejects(
    check(),
    (error: unknown) =>
      isRetrievalInfrastructureError(error) &&
      error.component === "leak-filter" &&
      error.code === "review_failed",
  );
  await assert.rejects(check(), isRetrievalInfrastructureError);

  assert.equal(calls, 4);
  assert.equal(filter.snapshot().reviewFailed, 2);
  assert.equal(filter.snapshot().cacheHits, 0);
  assert.equal(filter.snapshot().dropped, 0);
});

test("LeakFilter falls back to a second provider and archives which model decided", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primary: LlmClient = {
    id: "deepseek:flash",
    async complete() {
      primaryCalls++;
      throw new Error("primary reviewer unavailable");
    },
  };
  const fallback: LlmClient = {
    id: "bailian:qwen-flash",
    async complete() {
      fallbackCalls++;
      return {
        ...cleanCompletion,
        text: '{"leaked":true,"reason":"post-anchor outcome","evidence_quote":"Result declared later."}',
      };
    },
  };
  const filter = new LeakFilter(primary, {
    availabilityPolicy:"issued-information-v3",
    reviewConcurrency: 2,
    reviewAttempts: 2,
    fallbackClient: fallback,
    fallbackReviewAttempts: 2,
    retryDelayMs: 0,
  });

  const trace = await filter.checkWithTrace(
    "https://example.test/fallback",
    "fixture",
    "Result declared later.",
    "2026-01-01",
    { reviewAll: true },
  );

  assert.equal(trace.leaked, true);
  assert.equal(trace.reviewModel, "bailian:qwen-flash");
  assert.equal(trace.fallbackUsed, true);
  assert.equal(trace.primaryReviewAttempts, 2);
  assert.equal(trace.fallbackReviewAttempts, 1);
  assert.equal(trace.reviewAttempts, 3);
  assert.equal(primaryCalls, 2);
  assert.equal(fallbackCalls, 1);
  assert.equal(filter.snapshot().reviewFailed, 0);
  assert.equal(filter.snapshot().fallbackUsed, 1);
  assert.equal(filter.snapshot().fallbackSucceeded, 1);
  assert.equal(filter.snapshot().fallbackFailed, 0);

  const cached = await filter.checkWithTrace(
    "https://example.test/fallback",
    "fixture",
    "Result declared later.",
    "2026-01-01",
    { reviewAll: true },
  );
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.reviewModel, "bailian:qwen-flash");
  assert.equal(cached.fallbackUsed, true);
  assert.equal(primaryCalls, 2);
  assert.equal(fallbackCalls, 1);
});

test("LeakFilter archives verdict reason, exact evidence anchor, body hash and cache reuse", async () => {
  let calls = 0;
  const body = "Earlier context. The result was officially declared after the cutoff.";
  const quote = "The result was officially declared after the cutoff.";
  const client: LlmClient = {
    id: "fake:audit-filter",
    async complete() {
      calls++;
      return {
        ...cleanCompletion,
        text: JSON.stringify({
          leaked: true,
          reason: "Reports a settled post-anchor result.",
          evidence_quote: quote,
        }),
      };
    },
  };
  const filter = new LeakFilter(client, { availabilityPolicy:"issued-information-v3", reviewAttempts: 1, retryDelayMs: 0 });
  const first = await filter.checkWithTrace(
    "https://example.test/audit",
    "Audit fixture",
    body,
    "2026-01-01",
    { reviewAll: true },
  );
  const second = await filter.checkWithTrace(
    "https://example.test/audit",
    "Audit fixture",
    body,
    "2026-01-01",
    { reviewAll: true },
  );

  assert.equal(first.leaked, true);
  assert.equal(first.reason, "Reports a settled post-anchor result.");
  assert.equal(first.evidenceQuote, quote);
  assert.equal(first.evidenceStart, body.indexOf(quote));
  assert.equal(first.evidenceEnd, body.indexOf(quote) + quote.length);
  assert.equal(first.evidenceQuoteVerified, true);
  assert.match(first.bodySha256, /^[a-f0-9]{64}$/);
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
});
