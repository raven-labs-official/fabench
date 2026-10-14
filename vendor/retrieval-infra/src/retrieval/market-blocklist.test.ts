import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMarketHost,
  dropMarketHosts,
  countMarketPriceMentions,
} from "./market-blocklist.js";

test("market hosts are recognised, including subdomains and www", () => {
  for (const u of [
    "https://polymarket.com/event/x",
    "https://www.polymarket.com/event/x",
    "https://news.polymarket.com/a",
    "https://kalshi.com/markets/y",
    "https://manifold.markets/z",
    "https://www.metaculus.com/questions/1/",
  ]) {
    assert.equal(isMarketHost(u), true, u);
  }
});

test("news sites are not blocked, and a lookalike domain is not either", () => {
  for (const u of [
    "https://www.reuters.com/world/x",
    "https://apnews.com/article/y",
    // Match on the **host name** only. A news page whose path mentions polymarket must pass,
    // otherwise all news that reports on prediction markets would be removed, at a far higher
    // cost than the leak itself.
    "https://www.reuters.com/markets/polymarket-odds-story",
    "https://notpolymarket.com/x",
  ]) {
    assert.equal(isMarketHost(u), false, u);
  }
});

test("dropMarketHosts separates and reports what it removed", () => {
  const { kept, dropped } = dropMarketHosts([
    { url: "https://apnews.com/a" },
    { url: "https://polymarket.com/event/b" },
    { url: "https://www.bbc.com/c" },
    { url: "https://kalshi.com/d" },
  ]);
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 2);
  assert.deepEqual(dropped.map((d) => d.url), [
    "https://polymarket.com/event/b",
    "https://kalshi.com/d",
  ]);
});

test("counting price mentions catches the shapes actually seen in traces", () => {
  // These four are copied from text shapes that actually appeared in the 2026-08-31 records
  assert.equal(countMarketPriceMentions("Polymarket 24% chance as of Friday"), 1);
  assert.equal(countMarketPriceMentions("Kalshi favorite at 39% going in"), 1);
  assert.equal(countMarketPriceMentions("Polymarket pricing 12-24% on the strike"), 1);
  assert.equal(
    countMarketPriceMentions("Polymarket 30% and Kalshi 28 percent on the same day"),
    2,
  );
  // No false positives: no percentage, or a percentage too far from the market name
  assert.equal(countMarketPriceMentions("Polymarket launched a new category"), 0);
  assert.equal(countMarketPriceMentions("Unemployment fell to 4.1%"), 0);
});

test("malformed urls are not treated as market hosts", () => {
  assert.equal(isMarketHost("not a url"), false);
  assert.equal(isMarketHost(""), false);
});
