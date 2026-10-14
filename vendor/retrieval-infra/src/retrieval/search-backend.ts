import type { BrowseOptions, BrowsePage } from '../corpus/browse.js';
/**
 * The thing behind `web_search` / `web_fetch`, so the same agent can be pointed at different
 * worlds without knowing which one it is in.
 *
 * Three backends, and the comparison between them is the experiment:
 *
 *   frozen    our news archive, hard-filtered by crawl timestamp. Returned content
 *             physically predates the anchor. The shared index still uses global term
 *             statistics: it is content-isolated, not a historical ranking snapshot.
 *             search-snapshot.ts supplies an independent, capture-bounded index.
 *   web-filter live search plus page fetching, with every document reviewed for leakage
 *             before the model sees it. Content can be cleaned; RANKING cannot — today's
 *             search engine ordered those results using clicks and links that postdate the
 *             anchor, so this arm is an instrument, not a score.
 *   both      frozen first, then web-filter to fill the gap. The point is to measure what our
 *             archive is missing without pretending the web half is clean.
 *
 * WHY THE WEB PATH NEEDS THE FILTER MORE THAN THE FROZEN ONE DOES. A probe of the query
 * "US Iran military strike January 2026" returned, in its top four, "Timeline of the 2026
 * Iran war", "Iran Strikes Timeline — Every Event", and a continuously-updated Wikipedia
 * article on the 2026 build-up. Each of those is a living page: fetched today it contains
 * everything that happened after the anchor. This is the first of the four leakage channels
 * a 2026 study identified, and it is why 71% of questions leaked under plain date-restricted
 * search there.
 */
import { querySnippet } from "./snippet.js";
import type { CorpusStore } from "../corpus/store.js";
import { RetrievalInfrastructureError } from "./infrastructure-error.js";
import { dropMarketHosts } from "./market-blocklist.js";
import { isWithheld, type LeakFilter, type LeakFilterDocumentTrace, type LeakReviewContext } from "./leak-filter.js";
import type { DatedPage, PageDater } from "./page-dater.js";
import { searchTransportCounters, type SearchProvider } from "./search-providers.js";

export interface BackendResult {
  title: string;
  url: string;
  snippet: string;
  contentKind?: 'approved-summary';
  summaryPolicy?: string;
  documentId?: string;
  fullBodyChars?: number;
  offset?: number;
  nextOffset?: number | null;
  truncated?: boolean;
  /**
   * Which world this came from. The combined arm cannot answer what our archive is missing
   * unless each document says where it came from, so this is load-bearing, not bookkeeping.
   */
  source?: "frozen" | "web" | "backsearch" | "historical";
  evidence?: import("../corpus/historical-snapshot.js").HistoricalEvidence;
  /**
   * When the crawler physically observed this page, when the backend knows.
   *
   * Carried because the leakage rate is otherwise unmeasurable: without a timestamp on the
   * documents that actually reached the model, "how much of what we served was from after
   * the anchor" has no denominator. `frozen` has always had this in `SearchHit.crawlDate`
   * and dropped it here; the live arm can only supply what page dating recovered.
   */
  crawlDate?: string;
  /** The page's self-reported publication date. Never the isolation criterion — see docs/validity.md A.1. */
  publishDate?: string;
}

export interface BackendDoc {
  title: string;
  url: string;
  body: string;
  documentId?: string;
  fullBodyChars?: number;
  offset?: number;
  nextOffset?: number | null;
  truncated?: boolean;
  source?: "frozen" | "web" | "backsearch" | "historical";
  evidence?: import("../corpus/historical-snapshot.js").HistoricalEvidence;
  crawlDate?: string;
  publishDate?: string;
}

/** Per-search retrieval funnel archived beside the tool call. No secret values are included. */
export interface SearchFunnelTrace {
  backend: string;
  provider?: string;
  /** Exact question boundary and the coarser calendar cutoff sent to the search provider. */
  anchor_utc: string;
  provider_date_cutoff: string;
  page_date_policy: "date-only-inclusive" | "calendar-day-must-end-before-anchor" | "evidence-reviewed";
  provider_failed: boolean;
  provider_error?: string;
  requested_results: number;
  provider_hits: number;
  engine_date_dropped: number;
  engine_same_day_rejected: number;
  candidates_to_page_dater: number;
  page_records: number;
  pages_dated_pre_anchor: number;
  pages_undated: number;
  pages_post_anchor_or_invalid: number;
  /** Date-only evidence on the anchor's calendar day cannot prove it predates an exact time. */
  pages_same_day_rejected: number;
  pages_blocked_with_snippet: number;
  /** Prediction-market and betting-site pages blocked by domain before fetching */
  market_hosts_blocked: number;
  leak_reviews: number;
  leak_review_attempts: number;
  leak_dropped: number;
  uncertainty_dropped?: number;
  temporal_dropped?: number;
  leak_cache_hits: number;
  leak_review_failed: number;
  leak_cost_usd: number;
  served: number;
}

function directResponseAudit(page: DatedPage) {
  if (page.content_type === undefined && page.response_bytes_read === undefined && page.response_truncated === undefined) return {};
  return { direct_response: {
    content_type: page.content_type ?? null,
    bytes_read: page.response_bytes_read ?? null,
    truncated: page.response_truncated ?? null,
  } };
}

export interface SearchWithTraceResult {
  results: BackendResult[];
  /** Present for staged web filtering; frozen queries have no web/date-review funnel. */
  funnel?: SearchFunnelTrace;
  audit?: RetrievalAuditTrace;
}

export interface RetrievalCandidateAudit {
  started_at_utc?: string;
  finished_at_utc?: string;
  duration_ms?: number;
  operation_error?: string;
  review_failure?: { kind: string; provider?: string; status?: number; code: string | null };
  page_date_observation?: "pre-anchor" | "post-anchor-or-same-day" | "undated";
  document_id?: string;
  evidence_receipt_id?: string;
  provider_rank: number;
  url: string;
  title: string;
  snippet: string;
  engine_reported_date: string | null;
  engine_date_decision:
    | "fetch"
    | "rejected_after_anchor"
    | "outside_fetch_window";
  fetch?: {
    source: "direct" | "reader" | "browser" | null;
    date: string | null;
    last_modified: string | null;
    why: string;
    duration_ms: number | null;
    body: string;
    text_extraction?: DatedPage["text_extraction"];
    /** Direct HTTP response metadata, even when Reader later supplies the body. */
    direct_response?: {
      content_type: string | null;
      bytes_read: number | null;
      truncated: boolean | null;
    };
  };
  page_date_decision:
    | "not_evaluated"
    | "accepted"
    | "rejected_after_anchor"
    | "undated_or_unavailable"
    | "missing_result";
  leak_filter?: Omit<LeakFilterDocumentTrace, "verdict">;
  final_disposition:
    | "review_failed"
    | "passed_but_search_failed"
    | "duplicate_content"
    | "content_unusable"
    | "served_to_forecaster"
    | "passed_but_not_served_limit"
    | "outside_fetch_window"
    | "engine_date_rejected"
    | "page_date_rejected"
    | "fetch_undated_or_blocked"
    | "dater_missing_result"
    | "market_host_rejected"
    | "leak_rejected"
    | "uncertainty_rejected"
    // Only with dateGate="content": the date gate could not admit the page, but the content
    // judge read the body and found nothing after the anchor, so it was admitted on content.
    // Two values rather than one, because "no date could be found" and "the date is clearly
    // after the anchor" carry different risks and must be counted separately afterwards.
    | "content_cleared_undated"
    | "content_cleared_postdate";
  served_to_forecaster: boolean;
  acquisition_ms?: number;
  review_ms?: number;
}

export interface RetrievalAuditTrace {
  started_at_utc?: string;
  elapsed_ms?: number;
  provider_ms?: number;
  execution_policy?: { version: string; candidate_concurrency: number; selection: string };
  operation_error?: string;
  schema_version: "raven.retrieval-audit.v1";
  operation: "search" | "fetch";
  backend: string;
  provider?: string;
  query?: string;
  requested_url?: string;
  anchor_utc: string;
  provider_date_cutoff?: string;
  provider_error?: string;
  candidates: RetrievalCandidateAudit[];
}

export interface FetchWithTraceResult {
  doc: BackendDoc | null;
  audit?: RetrievalAuditTrace;
}

export interface SearchBackend {
  readonly name: string;
  /** Exhaustive, cursor-paged capture browsing for an entity and time range. */
  browse?(options: BrowseOptions, asOf: string, context?: LeakReviewContext): Promise<BrowsePage>;
  readonly fullTextResults?: boolean;
  readonly searchDelivery?: 'fulltext' | 'summary';
  search(query: string, n: number, asOf: string): Promise<BackendResult[]>;
  /** Optional per-call funnel, used where a backend has multiple filtering stages. */
  searchWithTrace?(
    query: string,
    n: number,
    asOf: string,
    context?: LeakReviewContext,
  ): Promise<SearchWithTraceResult>;
  fetch(url: string, asOf: string): Promise<BackendDoc | null>;
  fetchWithTrace?(url: string, asOf: string, context?: LeakReviewContext): Promise<FetchWithTraceResult>;
  /** Per-run counters for the archive; shape is backend-specific. */
  stats(): Record<string, number>;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calendar cutoff for providers whose API cannot express a time of day.
 *
 * A midnight timestamp means the new day has only just begun, so an inclusive date filter
 * must stop at the preceding day. Intraday timestamps may ask the provider for the same day,
 * but the downstream page-date gate still rejects same-day, date-only evidence because it
 * cannot prove which side of the timestamp the page was published on.
 */
export function providerDateCutoff(asOf: string): string {
  if (DATE_ONLY.test(asOf)) return asOf;
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) throw new Error(`unparseable anchor: ${asOf}`);
  const d = new Date(t);
  const isMidnight =
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;
  return new Date(t - (isMidnight ? 86_400_000 : 0)).toISOString().slice(0, 10);
}

/**
 * True only when the available publication-date evidence proves the page is not later than
 * the question boundary. PageDater deliberately returns YYYY-MM-DD, so with an exact anchor
 * every same-calendar-day page is ambiguous and must be rejected. Date-only question anchors
 * retain their documented inclusive-day meaning.
 */
export function pageDateProvablyBeforeAnchor(pageDate: string, asOf: string): boolean {
  const pageDay = pageDate.slice(0, 10);
  if (!DATE_ONLY.test(pageDay)) return false;
  const dayMs = Date.parse(`${pageDay}T00:00:00Z`);
  if (!Number.isFinite(dayMs) || new Date(dayMs).toISOString().slice(0,10) !== pageDay) return false;
  if (DATE_ONLY.test(asOf)) return pageDay <= asOf;
  const anchorMs = Date.parse(asOf);
  if (Number.isNaN(anchorMs)) throw new Error(`unparseable anchor: ${asOf}`);
  return pageDay < new Date(anchorMs).toISOString().slice(0, 10);
}

function pageDatePolicy(
  asOf: string,
): SearchFunnelTrace["page_date_policy"] {
  return DATE_ONLY.test(asOf)
    ? "date-only-inclusive"
    : "calendar-day-must-end-before-anchor";
}

// ── frozen ───────────────────────────────────────────────────────────────────

export class FrozenBackend implements SearchBackend {
  readonly name = "frozen";
  private searches = 0;
  private fetches = 0;
  private withheld = 0;

  constructor(
    private readonly store: CorpusStore | import('../corpus/frozen-worker-pool.js').FrozenWorkerPool,
    private readonly leak?: LeakFilter,
  ) {}

  async search(query: string, n: number, asOf: string): Promise<BackendResult[]> {
    this.searches++;
    let hits = await this.store.search(query, asOf, n);
    if (this.leak) {
      const kept = await this.leak.filter(hits, asOf);
      this.withheld += hits.length - kept.length;
      hits = kept;
    }
    return hits.map((h) => ({
      title: h.title,
      url: h.url,
      snippet: querySnippet(h.body ?? "", query, 260),
      source: "frozen" as const,
      crawlDate: h.crawlDate,
    }));
  }

  async fetch(url: string, asOf: string): Promise<BackendDoc | null> {
    this.fetches++;
    const doc = await this.store.getByUrlBefore(url, asOf);
    if (!doc) return null;
    if (this.leak && isWithheld(await this.leak.check(doc.url, doc.title, doc.body, asOf))) {
      this.withheld++;
      return null;
    }
    return {
      title: doc.title,
      url: doc.url,
      body: doc.body.replace(/\s+/g, " "),
      source: "frozen",
      crawlDate: doc.crawlDate,
    };
  }

  stats() {
    return { searches: this.searches, fetches: this.fetches, withheld: this.withheld };
  }
}

// ── web ──────────────────────────────────────────────────────────────────────

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** DuckDuckGo wraps outbound links; unwrap to the real destination. */
function normaliseUrl(raw: string): string {
  try {
    const parsed = new URL(decodeURIComponent(raw), "https://duckduckgo.com");
    const target = parsed.searchParams.get("uddg");
    if (target) return target;
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

export class WebBackend implements SearchBackend {
  readonly name = "web-filter";
  private searches = 0;
  private fetches = 0;
  private withheld = 0;
  private failed = 0;
  private readonly pageCache = new Map<string, string | null>();

  /**
   * @param leak REQUIRED, unlike the frozen backend. Live results carry post-anchor content
   *   as a matter of course — see the header — so an unfiltered web arm would not be
   *   measuring retrieval at all.
   */
  constructor(
    private readonly leak: LeakFilter,
    private readonly timeoutMs = 20000,
  ) {}

  async search(query: string, n: number, asOf: string): Promise<BackendResult[]> {
    this.searches++;
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    let html = "";
    try {
      const res = await fetch(url, {
        headers: { accept: "text/html", "user-agent": "raven-bench/1.0" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        this.failed++;
        return [];
      }
      html = await res.text();
    } catch {
      this.failed++;
      return [];
    }

    const links = [
      ...html.matchAll(
        /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      ),
    ];
    const snippets = [
      ...html.matchAll(
        /<(?:a|div)[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/gi,
      ),
    ];
    const seen = new Set<string>();
    const out: BackendResult[] = [];
    for (const [i, m] of links.entries()) {
      const u = normaliseUrl(m[1] ?? "");
      const title = stripTags(m[2] ?? "");
      if (!u || !title || seen.has(u)) continue;
      seen.add(u);
      out.push({ title, url: u, snippet: stripTags(snippets[i]?.[1] ?? "").slice(0, 420) });
      if (out.length >= n) break;
    }

    // The snippet is reviewed too, not only the fetched page: a search result list is itself
    // readable content, and a snippet reading "the ceasefire was signed on May 20" leaks just
    // as effectively as the article behind it.
    const kept = await this.leak.filter(
      out.map((r) => ({ ...r, body: r.snippet })),
      asOf,
    );
    this.withheld += out.length - kept.length;
    return kept.map(({ title, url, snippet }) => ({ title, url, snippet }));
  }

  async fetch(url: string, asOf: string): Promise<BackendDoc | null> {
    this.fetches++;
    let text = this.pageCache.get(url) ?? null;
    if (!this.pageCache.has(url)) {
      try {
        const res = await fetch(url, {
          headers: { "user-agent": "raven-bench/1.0" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        text = res.ok ? stripTags(await res.text()) : null;
      } catch {
        text = null;
      }
      this.pageCache.set(url, text);
    }
    if (!text) {
      this.failed++;
      return null;
    }
    const title = text.slice(0, 120);
    if (isWithheld(await this.leak.check(url, title, text, asOf))) {
      this.withheld++;
      return null;
    }
    return { title, url, body: text };
  }

  stats() {
    return {
      searches: this.searches,
      fetches: this.fetches,
      withheld: this.withheld,
      failed: this.failed,
    };
  }
}

// ── both ─────────────────────────────────────────────────────────────────────

/**
 * Both worlds, each contributing its own results rather than sharing a quota.
 *
 * The earlier version asked frozen for n and let web fill whatever was left. Measured over 89
 * questions, frozen filled the quota almost every time and web ran 76 searches against
 * frozen's 1,284 — so "both" was "frozen" with a rounding error, and the small score
 * difference between them came from six live pages. A shared quota cannot answer the question
 * this arm exists for.
 *
 * Here each side is asked independently and both sets are served. Duplicates resolve to the
 * frozen copy: its age is a physical fact about when a crawler held the bytes, while the live
 * copy's age is the page's own claim about itself, and the same story is worth more from the
 * source we can prove. What remains after that is precisely the web's contribution — the
 * documents our archive did not have — which is the measurement.
 */
/**
 * Merge several retrieval branches into one tool the model cannot tell apart.
 *
 * Branch order is priority order: the first branch's results are kept whole, and each later
 * branch contributes only what the earlier ones did not already have. That asymmetry is the
 * point — with the archive first, whatever a later branch adds IS the archive's gap, measured
 * rather than argued. Each result keeps its own `source`, so the gap is countable after the
 * fact instead of inferred from a score difference.
 *
 * An earlier version ran the branches sequentially and gave the frozen side the whole result
 * budget first, asking the network only for the remainder. Across 89 questions the archive
 * filled every slot on nearly every query — the network was called 76 times against the
 * archive's 1,284 — so that "combination" was the archive alone wearing a different name.
 * Every branch now searches the full width independently and merging happens afterwards.
 */
export class MergeBackend implements SearchBackend {
  readonly name: string;
  private readonly ms: number[];
  private calls = 0;

  constructor(private readonly branches: SearchBackend[], name?: string) {
    if (branches.length < 2)
      throw new Error("a merged backend needs at least two branches");
    this.name = name ?? branches.map((b) => b.name).join("+");
    this.ms = branches.map(() => 0);
  }

  /** Same story, different outlets: compare on a normalised title. */
  private static key(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
  }

  async search(query: string, n: number, asOf: string): Promise<BackendResult[]> {
    // Concurrent, not sequential: the branches share nothing, so running them one after
    // another would make every combined search cost the SUM of a SQL query and a network round
    // trip rather than the slower of the two. The per-branch timings are recorded because
    // "they run in parallel" is a claim about the code that the numbers either confirm or
    // don't — if the total tracks the sum rather than the max, something is serialising.
    this.calls++;
    const t0 = Date.now();
    const results = await Promise.all(
      this.branches.map((b, i) =>
        b.search(query, n, asOf).then((r) => {
          this.ms[i]! += Date.now() - t0;
          return r;
        }),
      ),
    );
    const seenUrl = new Set<string>();
    const seenTitle = new Set<string>();
    const out: BackendResult[] = [];
    for (const branch of results) {
      for (const r of branch) {
        const k = MergeBackend.key(r.title);
        if (seenUrl.has(r.url) || (k && seenTitle.has(k))) continue;
        seenUrl.add(r.url);
        if (k) seenTitle.add(k);
        out.push(r);
      }
    }
    return out;
  }

  async fetch(url: string, asOf: string): Promise<BackendDoc | null> {
    for (const b of this.branches) {
      const doc = await b.fetch(url, asOf);
      if (doc) return doc;
    }
    return null;
  }

  stats() {
    const n = Math.max(1, this.calls);
    const out: Record<string, number> = {};
    this.branches.forEach((b, i) => {
      // Prefixed by the branch's own name rather than a fixed literal, so any combination
      // archives its halves under the right labels. Unchanged for the frozen+web pair.
      for (const [k, v] of Object.entries(b.stats())) out[`${b.name}_${k}`] = v;
      // Milliseconds per combined search, so the branches can be compared directly.
      out[`${b.name}_ms_avg`] = Math.round(this.ms[i]! / n);
    });
    return out;
  }
}

/** The original two-branch form, kept because `both` is the name used in every archived run. */
export class BothBackend extends MergeBackend {
  constructor(frozen: SearchBackend, web: SearchBackend) {
    super([frozen, web], "both");
  }
}


// ── the model's own search tool, dated and reviewed ─────────────────────────

/**
 * Live web search: the model's own search tool, then our gate.
 *
 * The pipeline, and why each step is where it is:
 *
 *   1. SEARCH via the model's own web-search tool. Not a scraper we wrote — an earlier
 *      attempt scraped DuckDuckGo directly and at benchmark scale it began answering 302
 *      with an empty body, so 1,524 of 1,531 searches returned nothing while the summary
 *      table printed a clean Brier score. The search tool returns a title and a URL and
 *      NOTHING ELSE: no date field at all, verified against its raw output.
 *   2. FETCH AND DATE each result with htmldate (see PageDater). This is the step that costs
 *      time, and it is not optional: without a date there is no way to show a page predates
 *      the anchor, and step 1 does not supply one.
 *   3. DROP the undated. A page that cannot be dated is not admitted with a shrug.
 *   4. DROP anything dated after the anchor.
 *   5. REVIEW the content with a model. Unlike the frozen path, this runs on EVERY surviving
 *      document rather than only on ones a cheap scan flags. The cheap scan looks for a
 *      post-anchor date in the body, which presumes that a document physically older than the
 *      anchor can only leak by naming a later date — true when crawl time guarantees the age,
 *      false here. A live page saying "X happened", with no date anywhere in it, passes every
 *      earlier step and is exactly the case that matters.
 *
 * Still audit-only, for a reason no filter reaches: the RANKING is today's. Which results
 * came back at all was decided by an engine that has seen the outcome, and re-ranking cannot
 * un-see it. This arm measures what our archive is missing; it never scores a forecast.
 */
/**
 * Admission mode of the date gate.
 *
 * `strict` is the original behaviour: a page with no date, or with a date not provably before
 * the anchor, is dropped at once and never reaches the content judge.
 * `content` hands both kinds to the content judge instead (`reviewAll: true`, the same standard
 * as already admitted pages); a page is admitted only if the judge finds nothing after the
 * anchor, and its disposition is recorded and counted separately in the run summary.
 *
 * Why relaxing it is worth it: measured on 2026-09-06 on the archived bodies of a 293-question
 * web-filter run, of the 320 pages the date gate rejected as "page date after the anchor", the
 * content judge found **47% clean**, and the share did not change with how far after the anchor
 * the page was (1-7 days 39%, 7-30 days 54%, 30-90 days 46%, over 90 days 49%). Sixteen of them
 * were read by hand (4 drawn at random from over 90 days, 12 from the highest-risk remainder,
 * "judged clean but the body does contain a post-anchor date"), and **all 16 were judged
 * correctly**: every post-anchor date was page furniture (sidebar event teasers, Last Updated
 * timestamps, site headers) or a forward-looking schedule ("next earnings around April 29",
 * "tariffs expire July 24"), which is exactly what a forecaster at the anchor should see. An
 * objective scan agrees: 13% of pages judged clean contain a post-anchor date in the body,
 * against 45% of pages judged leaking.
 *
 * The backend API defaults to strict; forecast-value defaults to content under the v5 policy
 * and still to strict under older policies. The explicit switch and the condition identity keep
 * both treatments apart, so cells of one cannot be reused for the other.
 * The recomputation script is `question-making/retrieval/leak-filter-recall.ts`.
 */
export type DateGateMode = "strict" | "content";

export class WebSearchBackend implements SearchBackend {
  readonly name = "web-filter";
  private searches = 0;
  private fetches = 0;
  private postAnchor = 0;
  private withheld = 0;
  private uncertaintyWithheld = 0;
  private failedSearch = 0;
  private consecutiveSearchFailures = 0;
  private consecutiveZeroServed = 0;
  private maxConsecutiveZeroServedObserved = 0;
  private zeroServedWarnings = 0;
  private circuitOpen = false;
  private circuitError?: RetrievalInfrastructureError;
  /** Failure text → how many times, so the run summary can name the cause. */
  private readonly searchErrors = new Map<string, number>();
  /** Dropped on the engine's own date, without a fetch. */
  private preFiltered = 0;
  /** Fetch-blocked, but the search engine returned a snippet we chose not to use. */
  private blockedWithSnippet = 0;
  /** Prediction-market and betting-site pages blocked by domain before fetching. A silent filter is as good as none, so it is counted. */
  private marketHostsBlocked = 0;
  /** With dateGate="content", the two kinds admitted by the content judge, counted separately. */
  private contentClearedUndated = 0;
  private contentClearedPostDate = 0;

  constructor(
    private readonly provider: SearchProvider,
    private readonly dater: PageDater,
    private readonly leak: LeakFilter,
    private readonly circuit = {
      maxConsecutiveSearchFailures: 3,
      maxConsecutiveZeroServed: 5,
    },
    private readonly dateGate: DateGateMode = "strict",
  ) {}

  /** Whether the date gate would reject this page under strict. */
  private failsDateGate(page: { date?: string | null }, asOf: string): boolean {
    return !page.date || !pageDateProvablyBeforeAnchor(page.date, asOf);
  }

  private trip(error: RetrievalInfrastructureError): RetrievalInfrastructureError {
    this.circuitOpen = true;
    this.circuitError ??= error;
    return this.circuitError;
  }

  async search(query: string, n: number, asOf: string): Promise<BackendResult[]> {
    return (await this.searchWithTrace(query, n, asOf)).results;
  }

  async searchWithTrace(
    query: string,
    n: number,
    asOf: string,
    context?: LeakReviewContext,
  ): Promise<SearchWithTraceResult> {
    if (this.circuitError) throw this.circuitError;
    this.searches++;
    const providerCutoff = providerDateCutoff(asOf);
    const datePolicy = pageDatePolicy(asOf);
    let hits: { url: string; title: string; snippet?: string; date?: string }[];
    try {
      // Pass the anchor so a date-capable provider (Serper) restricts Google to on-or-before
      // the anchor. This attacks the largest loss in this funnel — ~75% of default-ranked
      // results were post-anchor — at the source, before any fetch is paid for.
      hits = await this.provider.search(query, n * 2, providerCutoff);
    } catch (e) {
      // Keep the reason, not just the count. A run once reported "673 searches failed" with
      // no way to tell an exhausted API balance from a timeout — they need opposite fixes,
      // and the answer turned out to be a flat "Not enough credits" that a counter cannot say.
      this.failedSearch++;
      this.consecutiveSearchFailures++;
      const why = String((e as Error)?.message ?? e).slice(0, 120);
      this.searchErrors.set(why, (this.searchErrors.get(why) ?? 0) + 1);
      if (
        this.consecutiveSearchFailures >=
        this.circuit.maxConsecutiveSearchFailures
      ) {
        throw this.trip(
          new RetrievalInfrastructureError(
            "search-provider",
            "consecutive_failures",
            `${this.provider.name} failed ${this.consecutiveSearchFailures} consecutive searches: ${why}`,
            { cause: e },
          ),
        );
      }
      return {
        results: [],
        funnel: {
          backend: this.name,
          provider: this.provider.name,
          anchor_utc: asOf,
          provider_date_cutoff: providerCutoff,
          page_date_policy: datePolicy,
          provider_failed: true,
          provider_error: why,
          requested_results: n,
          provider_hits: 0,
          engine_date_dropped: 0,
          engine_same_day_rejected: 0,
          candidates_to_page_dater: 0,
          page_records: 0,
          pages_dated_pre_anchor: 0,
          pages_undated: 0,
          pages_post_anchor_or_invalid: 0,
          pages_same_day_rejected: 0,
          pages_blocked_with_snippet: 0,
          market_hosts_blocked: 0,
          leak_reviews: 0,
          leak_review_attempts: 0,
          leak_dropped: 0,
          leak_cache_hits: 0,
          leak_review_failed: 0,
          leak_cost_usd: 0,
          served: 0,
        },
        audit: {
          schema_version: "raven.retrieval-audit.v1",
          operation: "search",
          backend: this.name,
          provider: this.provider.name,
          query,
          anchor_utc: asOf,
          provider_date_cutoff: providerCutoff,
          provider_error: why,
          candidates: [],
        },
      };
    }
    this.consecutiveSearchFailures = 0;
    // Discard what the engine already says is after the anchor, before paying to fetch it.
    // Measured on the 100-question run: 75% of results were post-anchor, and every one of
    // them cost a page fetch whose only purpose was to confirm what the engine had already
    // said. Fetching is where this path was losing everything — 58% of requests were refused,
    // and a refused page has no date, so it was dropped anyway.
    //
    // Only ever removes: engines report FIRST PUBLICATION, we test LAST MODIFICATION, and
    // last-modified >= published — so "engine says after the anchor" proves after the anchor.
    // "Engine says before" proves nothing and still gets fetched and dated properly.
    let engineSameDayRejected = 0;
    const windowHits = hits.slice(0, n * 2);
    const candidates = windowHits.filter((h) => {
      if (!h.date) return true;
      const parsed = Date.parse(h.date);
      if (Number.isNaN(parsed)) return true;
      const engineDay = new Date(parsed).toISOString().slice(0, 10);
      if (pageDateProvablyBeforeAnchor(engineDay, asOf)) return true;
      if (!DATE_ONLY.test(asOf) && engineDay === asOf.slice(0, 10)) {
        engineSameDayRejected++;
      }
      this.preFiltered++;
      this.postAnchor++;
      return false;
    });
    // Fourth guard against market prices: prediction-market and betting-site pages are removed
    // **before fetching**. The first three guards block what we hand over, not what the model
    // searches for itself. In 982 measured cells (one question × one arm), 15 had queries that
    // named polymarket / kalshi, and in 4 a market's probability actually reached what the model
    // read; 3 of those came from the offline corpus arm, because news bodies quote odds
    // themselves. The reasoning and numbers are in the header of market-blocklist.ts.
    const { kept: fetchable, dropped: marketDropped } = dropMarketHosts(candidates);
    this.marketHostsBlocked += marketDropped.length;
    const pages = await this.dater.fetchMany(fetchable.map((h) => h.url));
    // A page we cannot fetch is not necessarily a page we know nothing about. The sites that
    // refuse us do so through CDN bot rules aimed at AI crawlers — thehill.com's robots.txt
    // names GPTBot, OAI-SearchBot and PerplexityBot and leaves Googlebot alone — so the
    // search engine holds an indexed copy even where a direct fetch returns 403. Its snippet
    // is a few sentences rather than an article, which is thin but not nothing.
    //
    // It is NOT admitted here. A snippet carries no publication date, and this path exists
    // precisely because a document that cannot be shown to predate the anchor must not reach
    // the forecaster. Counting them instead makes the size of the loss visible: if the number
    // is large, buying dates for those hosts is worth doing; if it is small, it is not.
    const snippetByUrl = new Map(hits.filter((h) => h.snippet).map((h) => [h.url, h.snippet!]));
    let blockedWithSnippet = 0;
    for (const p of pages) {
      if (!p.date && /^HTTP 4|^HTTP 5/.test(p.why) && snippetByUrl.has(p.url)) {
        this.blockedWithSnippet++;
        blockedWithSnippet++;
      }
    }
    let sameDayRejected = 0;
    // strict: a page that fails the date gate is dropped here. content: any page with a fetched
    // body goes to the content judge, which decides from the body. "Failed the date gate" is
    // counted the same way in both modes, so pages_post_anchor_or_invalid in the run summary
    // still means the same thing.
    const dated = pages.filter((p) => {
      const failsDate = this.failsDateGate(p, asOf);
      if (failsDate && p.date) {
        if (!DATE_ONLY.test(asOf) && p.date.slice(0, 10) === asOf.slice(0, 10)) {
          sameDayRejected++;
        }
        this.postAnchor++;
      }
      if (!failsDate) return true;
      if (this.dateGate !== "content") return false;
      // Without a body there is nothing to judge, so it is still dropped: the content judge is
      // not a path for "unknown, let it through".
      return Boolean(p.text && p.text.trim());
    });

    let kept: Awaited<ReturnType<LeakFilter["filter"]>>;
    let leakTrace: Awaited<ReturnType<LeakFilter["filterWithTrace"]>>["trace"];
    try {
      const filtered = await this.leak.filterWithTrace(
        dated.map((p) => ({ url: p.url, title: p.title, body: p.text })),
        asOf,
        { reviewAll: true, ...context },
      );
      kept = filtered.items;
      leakTrace = filtered.trace;
    } catch (error) {
      throw new RetrievalInfrastructureError(
        "leak-filter",
        "review_failed",
        `web-filter leak review failed`,
        { cause: error },
      );
    }
    this.withheld += dated.length - kept.length;
    this.uncertaintyWithheld += leakTrace.uncertaintyDropped ?? 0;
    this.fetches += kept.length;

    // Correlated searches inside one question often ask whether the same not-yet-observed
    // event has happened. Several honest zero-result answers are therefore evidence, not an
    // infrastructure outage. Keep the streak as an observable quality warning; only typed
    // provider, dater, and reviewer failures are allowed to open the global arm circuit.
    if (hits.length > 0 && kept.length === 0) this.consecutiveZeroServed++;
    else this.consecutiveZeroServed = 0;
    this.maxConsecutiveZeroServedObserved = Math.max(
      this.maxConsecutiveZeroServedObserved,
      this.consecutiveZeroServed,
    );
    if (
      this.consecutiveZeroServed > 0 &&
      this.consecutiveZeroServed % this.circuit.maxConsecutiveZeroServed === 0
    ) this.zeroServedWarnings++;

    const byUrl = new Map(pages.map((p) => [p.url, p]));
    const results = kept.slice(0, n).map((k) => ({
      title: k.title,
      url: k.url,
      snippet: querySnippet(byUrl.get(k.url)?.text ?? "", query, 300),
      source: "web" as const,
      publishDate: byUrl.get(k.url)?.date ?? undefined,
    }));
    const candidateUrls = new Set(candidates.map((candidate) => candidate.url));
    const marketUrls = new Set(marketDropped.map((item) => item.url));
    const keptUrls = new Set(kept.map((item) => item.url));
    const servedUrls = new Set(results.map((item) => item.url));
    const leakByUrl = new Map(leakTrace.decisions.map((decision) => [decision.url, decision]));
    const auditCandidates: RetrievalCandidateAudit[] = hits.map((hit, index) => {
      const inWindow = index < windowHits.length;
      const selectedForFetch = inWindow && candidateUrls.has(hit.url);
      const page = byUrl.get(hit.url);
      const leakDecision = leakByUrl.get(hit.url);
      let finalDisposition: RetrievalCandidateAudit["final_disposition"];
      if (!inWindow) finalDisposition = "outside_fetch_window";
      else if (!selectedForFetch) finalDisposition = "engine_date_rejected";
      else if (marketUrls.has(hit.url)) finalDisposition = "market_host_rejected";
      else if (!page) finalDisposition = "dater_missing_result";
      else if (this.failsDateGate(page, asOf) && !leakDecision)
        // Failed the date gate and never reached the judge: the two original strict rejections
        finalDisposition = page.date ? "page_date_rejected" : "fetch_undated_or_blocked";
      else if (leakDecision?.leaked) finalDisposition = "leak_rejected";
      else if (leakDecision?.uncertain) finalDisposition = "uncertainty_rejected";
      else if (servedUrls.has(hit.url) || keptUrls.has(hit.url))
        // Failed the date gate but admitted by the judge: recorded separately, not mixed into served_to_forecaster
        finalDisposition = this.failsDateGate(page, asOf)
          ? page.date
            ? "content_cleared_postdate"
            : "content_cleared_undated"
          : servedUrls.has(hit.url)
            ? "served_to_forecaster"
            : "passed_but_not_served_limit";
      else finalDisposition = "fetch_undated_or_blocked";
      if (finalDisposition === "content_cleared_undated") this.contentClearedUndated++;
      if (finalDisposition === "content_cleared_postdate") this.contentClearedPostDate++;
      return {
        provider_rank: index + 1,
        url: hit.url,
        title: hit.title,
        snippet: hit.snippet ?? "",
        engine_reported_date: hit.date ?? null,
        engine_date_decision: !inWindow
          ? "outside_fetch_window"
          : selectedForFetch
            ? "fetch"
            : "rejected_after_anchor",
        ...(page
          ? {
              fetch: {
                source: page.source ?? null,
                date: page.date,
                last_modified: page.lastmod ?? null,
                why: page.why,
                duration_ms: page.ms ?? null,
                body: page.text,
                ...(page.text_extraction ? { text_extraction: page.text_extraction } : {}),
                ...directResponseAudit(page),
              },
            }
          : {}),
        page_date_decision: !selectedForFetch || marketUrls.has(hit.url)
          ? "not_evaluated"
          : !page
            ? "missing_result"
            : !page.date
              ? "undated_or_unavailable"
              : pageDateProvablyBeforeAnchor(page.date, asOf)
                ? "accepted"
                : "rejected_after_anchor",
        ...(leakDecision
          ? {
              leak_filter: Object.fromEntries(
                Object.entries(leakDecision).filter(([key]) => key !== "verdict"),
              ) as Omit<LeakFilterDocumentTrace, "verdict">,
            }
          : {}),
        final_disposition: finalDisposition,
        // This boolean must be independent of the disposition. It used to be
        // finalDisposition === "served_to_forecaster", which became wrong once the two
        // content_cleared_* dispositions were added: a document admitted by the content judge
        // **and actually given to the model** was recorded as served=false, so audits showed
        // fewer deliveries than there were. The disposition answers "how was it admitted"; this
        // boolean answers "did the model actually read it". They are different questions.
        served_to_forecaster: servedUrls.has(hit.url),
      };
    });
    const pagesUndated = pages.filter((page) => !page.date).length;
    return {
      results,
      funnel: {
        backend: this.name,
        provider: this.provider.name,
        anchor_utc: asOf,
        provider_date_cutoff: providerCutoff,
        page_date_policy: datePolicy,
        provider_failed: false,
        requested_results: n,
        provider_hits: hits.length,
        engine_date_dropped: hits.slice(0, n * 2).length - candidates.length,
        engine_same_day_rejected: engineSameDayRejected,
        candidates_to_page_dater: fetchable.length,
        page_records: pages.length,
        pages_dated_pre_anchor: pages.filter(p => !this.failsDateGate(p, asOf)).length,
        pages_undated: pagesUndated,
        pages_post_anchor_or_invalid: pages.filter(p => p.date && this.failsDateGate(p, asOf)).length,
        pages_same_day_rejected: sameDayRejected,
        pages_blocked_with_snippet: blockedWithSnippet,
        market_hosts_blocked: marketDropped.length,
        leak_reviews: leakTrace.reviewed,
        leak_review_attempts: leakTrace.reviewAttempts,
        leak_dropped: leakTrace.dropped - (leakTrace.uncertaintyDropped ?? 0),
        uncertainty_dropped: leakTrace.uncertaintyDropped ?? 0,
        temporal_dropped: leakTrace.dropped,
        leak_cache_hits: leakTrace.cacheHits,
        leak_review_failed: 0,
        leak_cost_usd: leakTrace.costUsd,
        served: results.length,
      },
      audit: {
        schema_version: "raven.retrieval-audit.v1",
        operation: "search",
        backend: this.name,
        provider: this.provider.name,
        query,
        anchor_utc: asOf,
        provider_date_cutoff: providerCutoff,
        candidates: auditCandidates,
      },
    };
  }

  async fetch(url: string, asOf: string): Promise<BackendDoc | null> {
    return (await this.fetchWithTrace(url, asOf)).doc;
  }

  async fetchWithTrace(url: string, asOf: string, context?: LeakReviewContext): Promise<FetchWithTraceResult> {
    if (this.circuitError) throw this.circuitError;
    if (dropMarketHosts([{ url }]).dropped.length) {
      this.marketHostsBlocked++;
      return { doc: null, audit: {
        schema_version: "raven.retrieval-audit.v1", operation: "fetch", backend: this.name,
        provider: this.provider.name, requested_url: url, anchor_utc: asOf,
        candidates: [{ provider_rank: 1, url, title: "", snippet: "", engine_reported_date: null,
          engine_date_decision: "fetch", page_date_decision: "not_evaluated",
          final_disposition: "market_host_rejected", served_to_forecaster: false }],
      } };
    }
    const [p] = await this.dater.fetchMany([url]);
    const base = {
      schema_version: "raven.retrieval-audit.v1" as const,
      operation: "fetch" as const,
      backend: this.name,
      provider: this.provider.name,
      requested_url: url,
      anchor_utc: asOf,
    };
    // In content mode a page with a fetched body but no date is no longer dropped here; it goes
    // to the content judge below. Without a body there is nothing to judge, so both modes drop
    // it: the content judge is not a path for "unknown, let it through".
    const contentRoute =
      this.dateGate === "content" && Boolean(p && p.text && p.text.trim());
    if (!p || (!p.date && !contentRoute)) {
      const disposition = p ? "fetch_undated_or_blocked" : "dater_missing_result";
      return {
        doc: null,
        audit: {
          ...base,
          candidates: [{
            provider_rank: 1,
            url,
            title: p?.title ?? "",
            snippet: "",
            engine_reported_date: null,
            engine_date_decision: "fetch",
            ...(p ? { fetch: {
              source: p.source ?? null,
              date: p.date,
              last_modified: p.lastmod ?? null,
              why: p.why,
              duration_ms: p.ms ?? null,
              body: p.text,
            } } : {}),
            page_date_decision: p ? "undated_or_unavailable" : "missing_result",
            final_disposition: disposition,
            served_to_forecaster: false,
          }],
        },
      };
    }
    const failsDate = this.failsDateGate(p, asOf);
    if (failsDate && p.date) this.postAnchor++;
    if (failsDate && !contentRoute) {
      return {
        doc: null,
        audit: {
          ...base,
          candidates: [this.fetchAuditCandidate(p, asOf, undefined, "page_date_rejected")],
        },
      };
    }
    let leakDecision: LeakFilterDocumentTrace;
    try {
      leakDecision = await this.leak.checkWithTrace(p.url, p.title, p.text, asOf, {
        reviewAll: true, ...context,
      });
    } catch (error) {
      throw new RetrievalInfrastructureError(
        "leak-filter",
        "review_failed",
        `web-filter leak review failed`,
        { cause: error },
      );
    }
    if (isWithheld(leakDecision)) {
      this.withheld++;
      if (leakDecision.uncertain) this.uncertaintyWithheld++;
      return {
        doc: null,
        audit: {
          ...base,
          candidates: [this.fetchAuditCandidate(p, asOf, leakDecision,
            leakDecision.leaked ? "leak_rejected" : "uncertainty_rejected")],
        },
      };
    }
    const admittedAs: RetrievalCandidateAudit["final_disposition"] = !failsDate
      ? "served_to_forecaster"
      : p.date
        ? "content_cleared_postdate"
        : "content_cleared_undated";
    if (admittedAs === "content_cleared_undated") this.contentClearedUndated++;
    if (admittedAs === "content_cleared_postdate") this.contentClearedPostDate++;
    return {
      doc: {
        title: p.title,
        url: p.url,
        body: p.text,
        source: "web",
        // In content mode this page may have no date at all; leave it empty rather than invent one.
        publishDate: p.date ?? undefined,
      },
      audit: {
        ...base,
        candidates: [this.fetchAuditCandidate(p, asOf, leakDecision, admittedAs)],
      },
    };
  }

  private fetchAuditCandidate(
    page: DatedPage,
    asOf: string,
    leakDecision: LeakFilterDocumentTrace | undefined,
    disposition: RetrievalCandidateAudit["final_disposition"],
  ): RetrievalCandidateAudit {
    // The fetch path handles one URL at a time: only an explicit admitted state marks it as
    // served, since that is the page returned to the model. Again, not inferred from the
    // disposition name.
    const served =
      disposition === "served_to_forecaster" ||
      disposition === "content_cleared_undated" ||
      disposition === "content_cleared_postdate";
    return {
      provider_rank: 1,
      url: page.url,
      title: page.title,
      snippet: "",
      engine_reported_date: null,
      engine_date_decision: "fetch",
      fetch: {
        source: page.source ?? null,
        date: page.date,
        last_modified: page.lastmod ?? null,
        why: page.why,
        duration_ms: page.ms ?? null,
        body: page.text,
        ...(page.text_extraction ? { text_extraction: page.text_extraction } : {}),
        ...directResponseAudit(page),
      },
      page_date_decision: !page.date ? "undated_or_unavailable"
        : pageDateProvablyBeforeAnchor(page.date, asOf) ? "accepted" : "rejected_after_anchor",
      ...(leakDecision
        ? {
            leak_filter: Object.fromEntries(
              Object.entries(leakDecision).filter(([key]) => key !== "verdict"),
            ) as Omit<LeakFilterDocumentTrace, "verdict">,
          }
        : {}),
      final_disposition: disposition,
      served_to_forecaster: served,
    };
  }

  /**
   * Fetch counters are deliberately absent: the dater is shared across every column in a run,
   * so reporting its totals under each backend would report the same numbers several times.
   * The run prints them once, separately.
   */
  stats() {
    const p = this.provider.stats();
    return {
      provider_requests: p.requests,
      provider_failed: p.failed,
      ...searchTransportCounters(this.provider),
      searches: this.searches,
      searches_failed: this.failedSearch,
      consecutive_search_failures: this.consecutiveSearchFailures,
      consecutive_zero_served: this.consecutiveZeroServed,
      max_consecutive_zero_served_observed:
        this.maxConsecutiveZeroServedObserved,
      zero_served_warnings: this.zeroServedWarnings,
      max_consecutive_search_failures:
        this.circuit.maxConsecutiveSearchFailures,
      zero_served_warning_threshold: this.circuit.maxConsecutiveZeroServed,
      circuit_open: this.circuitOpen ? 1 : 0,
      prefiltered_by_engine_date: this.preFiltered,
      ...Object.fromEntries(
        [...this.searchErrors].sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([why, n], i) => [`why_${i + 1}_${why.replace(/[^a-z0-9]+/gi, "_").slice(0, 48)}`, n]),
      ),
      blocked_but_snippet_available: this.blockedWithSnippet,
      // Pages blocked by the fourth market-price guard. This must appear in the run summary: for
      // a filter that reports no number, the next "how much did this run block" needs a rerun.
      market_hosts_blocked: this.marketHostsBlocked,
      after_anchor: this.postAnchor,
      leak_withheld: this.withheld - this.uncertaintyWithheld,
      uncertainty_withheld: this.uncertaintyWithheld,
      temporal_withheld: this.withheld,
      served: this.fetches,
      // These two are nonzero only with dateGate="content". They are the only measure of how much
      // material the relaxation actually let in; the run summary must show them, or the change
      // in the admission standard would be invisible in the results.
      date_gate_content_mode: this.dateGate === "content" ? 1 : 0,
      content_cleared_undated: this.contentClearedUndated,
      content_cleared_postdate: this.contentClearedPostDate,
    };
  }
}
