/**
 * Which hosts belong in the frozen corpus, and which documents carry wire copy.
 *
 * CC-News is a crawl of "news-ish" hosts, not a curated feed, so it carries a
 * measurable amount of non-article template output: currency converters, crypto
 * token pages, stock-photo listings, auto-generated stock blurbs, even a staging
 * mirror of another site. In our 2025-09..10 slice that is 17.6% of documents and
 * 12.5% of what BM25 actually returns, so it displaces real evidence in top-k.
 *
 * Two design rules, both learned the hard way:
 *
 * 1. DENY TEMPLATES, NOT NON-NEWS. Government pages, court dockets and statistics
 *    releases are frequently the decisive evidence — often the literal resolution
 *    source a prediction market names. Published "news domain" allowlists delete
 *    all of them (checked: two well-known lists contain zero .gov/.edu/.int), so
 *    we deny specific commerce/catalog/test hosts and PRESERVE the official ones
 *    explicitly. Preserve always wins over deny.
 *
 * 2. DENY BY EVIDENCE, NOT BY REPUTATION. Every host below was confirmed by
 *    reading its actual stored body text. Low-quality or partisan journalism is
 *    NOT filtered here — that is a different judgement and does not belong in an
 *    ingestion policy.
 */

/**
 * Hosts whose pages are templates/catalogs, not articles.
 *
 * Every entry was confirmed by reading stored bodies (see verify-denylist.ts, which
 * prints the evidence). The comment on each line is the observed page shape. Two
 * signals rank candidates for that read — `shapeUniq`, the fraction of distinct
 * title skeletons after digit-normalisation, and mean body length — but neither
 * decides: westernjournal.com scores shapeUniq 0.107 and is real reporting, and
 * deccanherald.com averages 536 chars because our extractor truncates it, not
 * because it is junk. Signals shortlist; a human reads the text.
 */
const DENY_HOSTS = new Set([
  // shapeUniq 0.152 — "<Currency A> to <Currency B> Exchange Rate Chart", one per pair.
  "www.xe.com",
  // Token listing pages mass-produced per coin per locale ("<COIN> tokenomics").
  // NOTE: only this host. mexc.co and mexc.fm were ALSO denied at first and that was
  // wrong — they carry syndicated crypto/macro reporting (verified 2026-07-27), and
  // guilt-by-brand cost 103k real documents before it was caught.
  "www.mexc.com",
  // Staging mirror of brighteon.com; titles literally read "multi video test 05".
  "preproduction.printyourfood.com",
  // Stock-photo and photo-sharing catalogs. 365project averages 614 chars ("IMG_4240 by Annabelle").
  "www.rawpixel.com",
  "365project.org",
  // Company salary/careers directory, one page per company per locale.
  "www.levels.fyi",
  // shapeUniq 0.003 — 22k crawls of the SAME homepage.
  "www.crunchyroll.com",
  // Film catalog ("<Film> <Year> - Movie Quotes").
  "www.kinoafisha.info",
  // Trading-indicator storefront listings, not articles.
  "www.mql5.com",
  // MarketBeat's auto-generated comparison/holdings network: one page per filing or
  // per stock pair ("X versus Y Critical Review", "N Shares in X Bought by Y").
  // Judgement call, not pure template: the numbers are factual, but the pages are
  // machine-written at a volume that floods top-k. Flip DENY_AUTOMATED_FINANCE to
  // keep them if a question set is finance-heavy.
  "www.themarketsdaily.com",
  "www.tickerreport.com",
  "www.americanbankingnews.com",
  "www.etfdailynews.com",
  // Game patch-note listings — real content, but never decisive evidence here.
  "steamdb.info",
]);

/**
 * Press-release wires. Kept by DEFAULT: a company announcement is often the
 * decisive evidence for a market about that company. Toggleable because they are
 * also high-volume and promotional.
 */
const PR_WIRE_HOSTS = new Set([
  "www.einpresswire.com",
  "www.globenewswire.com",
  "www.prnewswire.com",
]);

/** Official/authoritative hosts that must never be dropped, whatever else matches. */
const PRESERVE_PATTERN =
  /(^|\.)(gov|mil|int)$|(^|\.)gov\.[a-z]{2}$|(^|\.)edu$|(^|\.)edu\.[a-z]{2}$|(^|\.)ac\.[a-z]{2}$|(^|\.)europa\.eu$/;
const PRESERVE_HOSTS = new Set([
  "un.org",
  "press.un.org",
  "reliefweb.int",
  "who.int",
  "imf.org",
  "worldbank.org",
  "oecd.org",
  "iaea.org",
  "wto.org",
  "courtlistener.com",
  "www.courtlistener.com",
  "en.wikipedia.org",
  // Official bodies that do NOT sit on a .gov/.mil/.int domain and so slip past the
  // pattern above. dvidshub.net is the US DoD's Defense Visual Information
  // Distribution Service — found only by auditing hosts the deny signals flagged.
  "www.dvidshub.net",
  "dvidshub.net",
]);

export function hostOf(url: string): string {
  const m = /^https?:\/\/([^/]+)/i.exec(url);
  return m ? m[1]!.toLowerCase() : "";
}

/** True if this host is authoritative and must be kept regardless of other rules. */
export function isPreserved(host: string): boolean {
  if (PRESERVE_HOSTS.has(host)) return true;
  const bare = host.replace(/^www\./, "");
  if (PRESERVE_HOSTS.has(bare)) return true;
  return PRESERVE_PATTERN.test(bare);
}

export interface FilterOptions {
  /** Drop press-release wires too. Default false — they can be decisive evidence. */
  dropPrWires?: boolean;
}

/** True if this document should be excluded from the corpus. Preserve beats deny. */
export function isJunkHost(host: string, opts: FilterOptions = {}): boolean {
  if (isPreserved(host)) return false;
  if (DENY_HOSTS.has(host)) return true;
  if (opts.dropPrWires && PR_WIRE_HOSTS.has(host)) return true;
  return false;
}

/**
 * Detect syndicated wire copy in a body.
 *
 * The major wires block Common Crawl's bot in robots.txt, so apnews.com and
 * reuters.com are absent from the corpus — but their articles are NOT: local
 * outlets and public-radio member stations republish them under their own domain
 * and do not block the crawler. Tagging these recovers tier-1 reporting that a
 * host-based view says we do not have.
 *
 * Deliberately matched on datelines and bylines near the top of the text, where
 * wire attribution appears; a passing mention deeper in an article is not a claim
 * that the article IS wire copy.
 */
const WIRE_PATTERNS: [string, RegExp][] = [
  ["AP", /\((?:AP|The Associated Press)\)|(?:^|\n)\s*By\s+(?:The\s+)?Associated Press\b|\bAssociated Press\s+(?:writer|correspondent)\b/i],
  ["Reuters", /\(Reuters\)|(?:^|\n)\s*By\s+[^\n]{0,60}\bReuters\b/i],
  ["AFP", /\(AFP\)|(?:^|\n)\s*By\s+[^\n]{0,40}\bAFP\b/i],
  ["NPR", /\bNPR News\b|(?:^|\n)\s*By\s+[^\n]{0,60}\bNPR\b|npr\.org/i],
];

/** Which wire this document appears to carry, or null. Checks only the head of the text. */
export function wireSource(body: string): string | null {
  const head = body.slice(0, 1500);
  for (const [name, re] of WIRE_PATTERNS) if (re.test(head)) return name;
  return null;
}
