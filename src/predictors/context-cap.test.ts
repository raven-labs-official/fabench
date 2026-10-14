import assert from "node:assert/strict";
import test from "node:test";
import type { LlmMessage } from "../llm/client.js";
import {
  CHARS_PER_TOKEN,
  DROPPED_NOTICE,
  SAFETY_FRACTION,
  capConversation,
  estimateTokens,
} from "./context-cap.js";

// Big enough that eight of them clear qwen3.6-35b-a3b's 229,376-token limit, which is the
// case this module exists for: 8 * 120,000 chars / 4 = 240,000 estimated tokens.
const article = (n: number, size = 120000): LlmMessage => ({
  role: "tool",
  toolCallId: `call_${n}`,
  content: `article ${n} `.padEnd(size, "x"),
});
const conversation = (articles: number): LlmMessage[] => [
  { role: "system", content: "You are a forecaster." },
  { role: "user", content: "Will the index close above 22,881.02 on July 31, 2026?" },
  ...Array.from({ length: articles }, (_, i) => article(i)),
  { role: "assistant", content: "Reading.", reasoning: "considering base rates" },
];

test("no cap leaves the conversation byte-identical, which every existing condition relies on", () => {
  const messages = conversation(6);
  for (const cap of [undefined, 0]) {
    const r = capConversation(messages, cap);
    assert.equal(r.messages, messages);
    assert.equal(r.dropped, 0);
    assert.equal(r.fits, true);
    assert.equal(r.estimatedAfter, r.estimatedBefore);
  }
});

test("a conversation already under budget is not touched", () => {
  const messages = conversation(1);
  const r = capConversation(messages, 1_048_576);
  assert.equal(r.messages, messages);
  assert.equal(r.dropped, 0);
  assert.equal(r.fits, true);
});

test("oldest tool results are dropped first, and only tool results", () => {
  const messages = conversation(8);
  // qwen3.6-35b-a3b's real limit, the one that killed 37 cells.
  const r = capConversation(messages, 229_376);
  assert.ok(r.dropped > 0 && r.dropped < 8, `expected a partial trim, dropped ${r.dropped}`);
  assert.equal(r.fits, true);
  assert.ok(r.estimatedAfter <= Math.floor(229_376 * SAFETY_FRACTION));

  assert.notEqual(r.messages, messages, "must not mutate the caller's history");
  assert.equal(messages[2].content.includes(DROPPED_NOTICE), false, "original stays intact");

  assert.equal(r.messages[0].content, "You are a forecaster.");
  assert.equal(r.messages[1].content, messages[1].content);
  assert.equal(r.messages.at(-1)!.content, "Reading.");
  assert.equal(r.messages.at(-1)!.reasoning, "considering base rates");

  const tools = r.messages.filter((m) => m.role === "tool");
  const notices = tools.map((m) => m.content === DROPPED_NOTICE);
  assert.deepEqual(notices.slice(0, r.dropped), Array(r.dropped).fill(true), "oldest go first");
  assert.equal(notices.slice(r.dropped).includes(true), false, "newest are kept");
  for (const [i, m] of tools.entries()) assert.equal(m.toolCallId, `call_${i}`, "ids survive");
});

test("a dropped result is announced rather than deleted, so the model can fetch it again", () => {
  const r = capConversation(conversation(8), 229_376);
  const notice = r.messages.find((m) => m.content === DROPPED_NOTICE);
  assert.ok(notice, "expected a visible notice");
  assert.equal(notice!.role, "tool");
  assert.match(DROPPED_NOTICE, /call the tool again/);
});

test("an unanswerable question reports fits=false instead of cutting into the question", () => {
  const messages: LlmMessage[] = [
    { role: "system", content: "You are a forecaster." },
    { role: "user", content: "x".repeat(400_000) },
    article(0),
  ];
  const r = capConversation(messages, 10_000);
  assert.equal(r.fits, false);
  assert.equal(r.messages[1].content.length, 400_000, "the question is never shortened");
  assert.equal(r.messages[2].content, DROPPED_NOTICE, "tool results are still given up first");
});

test("re-capping an already-capped conversation does not double-count notices", () => {
  const once = capConversation(conversation(8), 229_376);
  const twice = capConversation(once.messages, 229_376);
  assert.equal(twice.dropped, 0);
  assert.equal(twice.fits, true);
});

test("the estimate tracks size and stays on the documented characters-per-token basis", () => {
  assert.equal(estimateTokens([]), 0);
  const small = estimateTokens(conversation(1));
  const large = estimateTokens(conversation(4));
  assert.ok(large > small * 2, `expected growth with content: ${small} -> ${large}`);
  const one: LlmMessage[] = [{ role: "user", content: "y".repeat(4000) }];
  assert.ok(Math.abs(estimateTokens(one) - 4000 / CHARS_PER_TOKEN) < 20);
});
