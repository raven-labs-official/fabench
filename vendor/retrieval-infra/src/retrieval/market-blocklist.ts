/**
 * The fourth guard against market prices: **pages of prediction markets and betting sites
 * are never fetched.**
 *
 * The first three guards keep market prices from flowing out of our own side: price fields
 * on the question object are always empty, prompts are assembled from a field allowlist (never
 * by serialising the whole object), and an explicit market-blind instruction. They block what
 * **we** hand over. They cannot block what **the model searches for itself**.
 *
 * Why this layer exists, from measurement (2026-09-07 review of 982 cells, one cell = one
 * question × one arm; data from the 2026-08-31 analysis output `all_traces_meta.jsonl`, not
 * released with the repository):
 *
 *   15 cells had search queries that named a prediction-market site (offline corpus arm 12,
 *      web arm 3), e.g. `site:polymarket.com Iran military action ends April 2026`
 *   35 cells searched for odds / betting without naming a site
 *    4 cells had **a market's probability actually appear in what the model read**
 *      (offline corpus arm 3, web arm 1), e.g. "Polymarket 24%", "Kalshi favorite at 39%"
 *
 * Only those last 4 are real leaks, and **three came from the offline corpus arm**, the least
 * intuitive part: the offline corpus is news, and news reports quote Polymarket odds themselves.
 * So "offline, therefore clean" is wrong, and **both paths need the guard**.
 *
 * This layer blocks domains. It cannot block odds quoted inside a news article; that needs a
 * content-level count (`countMarketPriceMentions`), which only counts and never blocks, because
 * dropping every article that quotes odds would also remove a large amount of ordinary reporting,
 * a higher cost than the leak itself. **Measure the size first, then decide whether to block.**
 */

/** Prediction markets and betting sites. A match is never fetched. */
const MARKET_HOSTS = [
  "polymarket.com",
  "kalshi.com",
  "manifold.markets",
  "metaculus.com",
  "predictit.org",
  "smarkets.com",
  "betfair.com",
  "oddschecker.com",
  "insightprediction.com",
  "futuur.com",
  "goodjudgment.com",
  "gjopen.com",
  "infer-pub.com",
  "www.predictwise.com",
];

/** "A market name + a percentage" in a news article body. Used only to count, never to block. */
const PRICE_MENTION =
  /(polymarket|kalshi|manifold|metaculus|predictit|prediction market|betting market|bookmaker)[^.\n]{0,80}?(\d{1,3}(?:\.\d+)?)\s?(%|percent|cents?)/gi;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Whether this URL is a prediction market or betting site. Subdomains count too (news.polymarket.com matches). */
export function isMarketHost(url: string): boolean {
  const h = hostOf(url);
  if (!h) return false;
  return MARKET_HOSTS.some((m) => {
    const bare = m.replace(/^www\./, "");
    return h === bare || h.endsWith(`.${bare}`);
  });
}

/**
 * Remove market sites from the list to fetch and hand back how many were removed and which URLs.
 * **The count must go into the run record**: a silent filter is as good as no filter, and the
 * next time someone asks "how much did this run block", without the number the only answer is
 * a rerun.
 */
export function dropMarketHosts<T extends { url: string }>(
  items: T[],
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const it of items) (isMarketHost(it.url) ? dropped : kept).push(it);
  return { kept, dropped };
}

/**
 * Count the "market + percentage" mentions in a text.
 * Counts only, never blocks; see the file header for why.
 */
export function countMarketPriceMentions(text: string): number {
  if (!text) return 0;
  PRICE_MENTION.lastIndex = 0;
  let n = 0;
  while (PRICE_MENTION.exec(text) !== null) n++;
  return n;
}
