import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { LlmClient } from "../llm/benchmark-client.js";
import { limitModelConcurrency } from "./model-concurrency.js";

const reply = { text: "answer", costUsd: 0, inputTokens: 1, outputTokens: 1 };

test("conversations and native sessions share the forecast model limit and preserve closing", async () => {
  let active = 0, peak = 0, closed = 0;
  const base: LlmClient = {
    id: "fixture",
    complete: async () => {
      peak = Math.max(peak, ++active);
      await delay(5);
      active--;
      return reply;
    },
  };
  const client = limitModelConcurrency({
    ...base,
    startConversation: () => base,
    openForecast: () => ({ ...base, close: () => { closed++; } }),
  }, 2);
  const session = client.openForecast!();
  await Promise.all([client, client.startConversation!(), session, client].map(c => c.complete({ prompt: "same" })));
  session.close();
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(closed, 1);
});

test("queued cancellation does not call the provider or leak the slot; provider failures propagate", async () => {
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const prompts: string[] = [];
  const client = limitModelConcurrency({ id: "fixture", complete: async request => {
    prompts.push(request.prompt);
    if (request.prompt === "first") await blocker;
    if (request.prompt === "bad") throw new Error("provider failed");
    return reply;
  } }, 1);
  const first = client.complete({ prompt: "first" });
  const abort = new AbortController();
  const cancelled = client.complete({ prompt: "cancelled", signal: abort.signal });
  const cancellation = assert.rejects(cancelled, /cancelled/);
  abort.abort(new Error("cancelled"));
  await cancellation;
  const bad = assert.rejects(client.complete({ prompt: "bad" }), /provider failed/);
  const last = client.complete({ prompt: "last" });
  release();
  await Promise.all([first, bad, last]);
  assert.deepEqual(prompts, ["first", "bad", "last"]);
});
