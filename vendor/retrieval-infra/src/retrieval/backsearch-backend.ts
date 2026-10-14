/**
 * BackSearch: a third-party frozen archive, queried with an `as_of` date.
 *
 * Why this is a backend and not a `SearchProvider`. A provider's signature is
 * `search(query, n)` — no anchor — and everything that enters through that door is handed to
 * `WebSearchBackend`, which requires a PageDater and a LeakFilter and reviews every document
 * with an LLM. That pipeline exists because a live engine returns today's bytes with no
 * statement of age. BackSearch returns `crawl_date` per hit and gates on it, so running it
 * through the live pipeline would pay for a fetch, a date extraction and an LLM review to
 * recover a fact the response already carried. It belongs beside `FrozenBackend`, not behind
 * the provider interface.
 *
 * What we get and what we give up, stated plainly because the arm is not comparable to
 * `frozen` without both halves:
 *
 *   + `as_of` gates on crawl_date, not the page's self-reported publication date — the same
 *     physical-fact principle our own corpus uses (see docs/validity.md A.1).
 *   + Ranking is frozen with the archive, so unlike the live arm it is not today's ranking
 *     applied to the past. That claim is the vendor's; we do not get to audit it, and the
 *     invariant probe in docs/retrieval.md is what turns it into a measurement.
 *   − News coverage starts 2025-12-01. Our corpus starts 2025-09-01. At a 2026-03 anchor that
 *     is 90 days of lookback against 181. Measured on run100b, 9.3% of the documents the model
 *     actually read fall before 2025-12-01 (33.2% of documents merely returned) — small on
 *     average, concentrated in "has this still not happened?" questions whose base rate lives
 *     in older reporting.
 *   − It is a black box. We cannot rebuild it, and neither can a reader.
 *   − Its fetch returns the LATEST capture at or before the cutoff; ours returns the EARLIEST
 *     (docs/validity.md A.1). Both are inside the anchor, but theirs is strictly weaker
 *     against a page revised after publication.
 *
 * SEC filings are excluded by default: the vendor gates those on filing date rather than
 * crawl date, which is the self-reported-date rule this project exists to avoid.
 */

import type { BackendDoc, BackendResult, SearchBackend } from "./search-backend.js";

const BASE = process.env.BACKSEARCH_BASE ?? "https://search.openreward.ai";

/**
 * Retrieval mode — a request parameter, not a response field.
 *
 * We have measured all three, once: 27 questions, 123 decisive facts, every arm in the same
 * run. Recall came out dense 56.1%, bm25 53.7%, hybrid 50.4% — and that ordering is NOISE.
 * Per-question differences have a standard deviation of 34 points, which puts the ~1.5-point
 * spread between modes about 4,000 questions away from being resolvable; an earlier round of
 * the same experiment produced the opposite ordering. Read as a ranking, this table would
 * license "dense is better", which the run it comes from explicitly refutes.
 *
 * So the default is the service default. Deviating from a vendor default needs a reason and
 * we do not have one, and matching it keeps our numbers comparable to anyone else's. What
 * matters is that the choice is PINNED and RECORDED — a run that does not archive which mode
 * it used cannot be compared to another run.
 */
export type BackSearchMode = "dense" | "bm25" | "hybrid" | "hybrid-legacy";

/** News only. `cc_sec` gates on filing date, not crawl date — see the header. */
const DEFAULT_CORPORA = ["cc_news"] as const;

export interface BackSearchOptions {
  apiKey: string;
  mode?: BackSearchMode;
  /** Corpora to query. Adding `cc_sec` changes what "time isolation" means for that slice. */
  corpora?: readonly string[];
  timeoutMs?: number;
  /** Earliest date the archive covers; requests before it are a configuration error, not a miss. */
  coverageStart?: string;
  /**
   * Characters of article text to keep. `0` means the whole article, matching the
   * `--fetch-chars` CLI default and every other backend. It cannot mean "keep nothing":
   * `fetchChars ?? 4000` leaves 0 intact, and `slice(0, 0)` had this arm return an empty body
   * for every document while still counting the fetch as a success.
   */
  fetchChars?: number;
}

interface Hit {
  url?: string;
  title?: string;
  snippet?: string;
  host?: string;
  crawl_date?: string;
  publish_date?: string;
}

export class BackSearchLeakError extends Error {}

/**
 * `as_of` is date-only on this API and inclusive, while our corpus cuts at the anchor
 * timestamp itself. 216 of the 300 questions carry a midnight anchor, so passing the date
 * alone would hand this arm up to a full extra day of crawling that `frozen` cannot see — on
 * 72% of the question set. Take the calendar day BEFORE the anchor when the anchor is exactly
 * midnight, so both arms see the same closed interval.
 */
export function asOfParam(anchorIso: string): string {
  const t = Date.parse(anchorIso);
  if (Number.isNaN(t)) throw new Error(`unparseable anchor: ${anchorIso}`);
  const midnight = anchorIso.length > 10 && /T00:00(:00)?(\.0+)?Z?$/.test(anchorIso);
  return new Date(t - (midnight ? 86_400_000 : 0)).toISOString().slice(0, 10);
}

/**
 * The exact instant an intraday anchor cuts at, or 0 when the anchor is a whole day.
 *
 * A midnight or date-only anchor is already handled by `asOfParam`, which hands the API the
 * previous calendar day; everything it returns is then wholly inside the interval and needs no
 * second filter. An intraday anchor is different: the API is asked for that same day and can
 * return documents crawled after the anchor's clock time, so the caller has to re-filter.
 */
export function intradayCutoffMs(anchorIso: string): number {
  const t = Date.parse(anchorIso);
  if (Number.isNaN(t)) throw new Error(`unparseable anchor: ${anchorIso}`);
  const wholeDay = anchorIso.length <= 10 || /T00:00(:00)?(\.0+)?Z?$/.test(anchorIso);
  return wholeDay ? 0 : t;
}

export class BackSearchBackend implements SearchBackend {
  readonly name = "backsearch";
  private searches = 0;
  private searchesFailed = 0;
  private fetches = 0;
  private fetchesFailed = 0;
  private notInArchive = 0;
  private hitsReturned = 0;
  private candidatesSeen = 0;
  private served = 0;
  private emptySearches = 0;
  private undated = 0;
  private afterIntradayAnchor = 0;
  private fetchChars = 0;
  private readonly errors = new Map<string, number>();

  private readonly mode: BackSearchMode;
  private readonly corpora: readonly string[];
  private readonly timeoutMs: number;
  private readonly coverageStart: string;
  private readonly maxFetchChars: number;

  constructor(private readonly opts: BackSearchOptions) {
    if (!opts.apiKey) throw new Error("BackSearch needs OPENREWARD_API_KEY");
    this.mode = opts.mode ?? "hybrid";
    this.corpora = opts.corpora ?? DEFAULT_CORPORA;
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.BACKSEARCH_TIMEOUT_MS ?? 45_000);
    this.coverageStart = opts.coverageStart ?? process.env.BACKSEARCH_COVERAGE_START ?? "2025-12-01";
    // 0 is the CLI default and means "whole article"; only an absent value takes the fallback.
    this.maxFetchChars =
      opts.fetchChars === undefined || opts.fetchChars === null ? 4000 : opts.fetchChars;
  }

  private note(e: unknown): void {
    // Keep the reason, not just the count. "356 searches failed" cannot distinguish an
    // exhausted balance from a timeout, and those need opposite fixes. Digits are collapsed
    // EXCEPT three-digit HTTP status codes, which are the whole point of the bucket.
    const why = String((e as Error)?.message ?? e)
      .slice(0, 120)
      .replace(/\b(?!\d{3}\b)\d+\b/g, "N");
    this.errors.set(why, (this.errors.get(why) ?? 0) + 1);
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.opts.apiKey },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (r.status === 404) return { __missing: true };
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
      return (await r.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Refuse to run outside the archive's window instead of returning an empty result.
   *
   * The vendor's own client resolves a missing `as_of` to TODAY. A silent fallback to the
   * present is the one failure this benchmark cannot absorb: it would produce a full set of
   * confident scores with no signal anywhere that the anchor had stopped being enforced.
   */
  private cutoff(asOf: string): string {
    const day = asOfParam(asOf);
    if (day < this.coverageStart) {
      throw new Error(
        `anchor ${asOf} precedes BackSearch coverage (${this.coverageStart}); ` +
          `this arm cannot answer that question — drop it rather than scoring an empty search`,
      );
    }
    return day;
  }

  /**
   * Gate every hit on its crawl date, and drop the ones that cannot be gated.
   *
   * Two different failures, two different responses. A hit dated AFTER the cutoff means the
   * vendor's own `as_of` is not being enforced — the premise this arm rests on is false, so the
   * run is void and we throw. A hit with NO date cannot be shown to predate the anchor; it is
   * not evidence of a broken vendor, just a document we may not use. Admitting it would import
   * exactly the self-reported-date problem the frozen corpus exists to avoid, so it is dropped
   * and counted.
   *
   * Undated hits used to pass, because the check read `h.crawl_date && ...` — an absent date
   * short-circuited to "no violation".
   */
  private gate(hits: Hit[], day: string, cutoffMs: number, query: string): Hit[] {
    const kept: Hit[] = [];
    for (const h of hits) {
      if (!h.crawl_date) {
        this.undated++;
        continue;
      }
      if (h.crawl_date.slice(0, 10) > day) {
        throw new BackSearchLeakError(
          `BackSearch returned a post-anchor document: crawl_date=${h.crawl_date} > as_of=${day} ` +
            `(${h.url}) for query ${JSON.stringify(query)}. The time-isolation guarantee this ` +
            `arm rests on does not hold; the run is void.`,
        );
      }
      // The API only cuts at day granularity, so an intraday anchor can still be handed a
      // document crawled LATER THE SAME DAY. When the hit carries a time we close that gap
      // ourselves. When it carries only a date and that date IS the anchor's day, nothing in
      // the response places it before the anchor — `Date.parse("2026-03-21")` is midnight, which
      // would let a document crawled at 23:00 pass a 11:55 anchor. Drop it.
      if (cutoffMs > 0) {
        const dateOnly = h.crawl_date.length <= 10;
        if (dateOnly) {
          if (h.crawl_date.slice(0, 10) === day) {
            this.afterIntradayAnchor++;
            continue;
          }
        } else {
          const t = Date.parse(h.crawl_date);
          if (Number.isNaN(t)) {
            this.undated++;
            continue;
          }
          if (t > cutoffMs) {
            this.afterIntradayAnchor++;
            continue;
          }
        }
      }
      kept.push(h);
    }
    return kept;
  }

  async search(query: string, n: number, asOf: string): Promise<BackendResult[]> {
    const day = this.cutoff(asOf);
    this.searches++;
    let body: Record<string, unknown>;
    try {
      body = await this.post("/search", {
        query,
        as_of: day,
        k: n,
        mode: this.mode,
        corpus: this.corpora,
      });
    } catch (e) {
      if (e instanceof BackSearchLeakError) throw e;
      this.searchesFailed++;
      this.note(e);
      return [];
    }
    const raw = (Array.isArray(body.hits) ? body.hits : []) as Hit[];
    this.hitsReturned += raw.length;
    this.candidatesSeen += Number(body.candidates ?? 0);
    const hits = this.gate(raw, day, intradayCutoffMs(asOf), query);
    if (!hits.length) this.emptySearches++;

    const out = hits
      .filter((h): h is Hit & { url: string } => Boolean(h.url))
      .map((h) => ({
        title: h.title ?? h.url,
        url: h.url,
        snippet: (h.snippet ?? "").replace(/\s+/g, " ").slice(0, 260),
        source: "backsearch" as const,
        crawlDate: h.crawl_date,
        publishDate: h.publish_date,
      }));
    this.served += out.length;
    return out;
  }

  async fetch(url: string, asOf: string): Promise<BackendDoc | null> {
    const day = this.cutoff(asOf);
    this.fetches++;
    let body: Record<string, unknown>;
    try {
      // `summarize` stays off: a summary is model output, which is neither the archived bytes
      // nor reproducible across calls, and this arm's whole claim is that it serves an archive.
      body = await this.post("/fetch", { url, as_of: day, summarize: false });
    } catch (e) {
      this.fetchesFailed++;
      this.note(e);
      return null;
    }
    // A 404 is "not in the archive at that date" — a coverage fact, not a network error. The
    // live arm cannot tell these apart; here they must not share a counter, because one is
    // measured by the corpus chapter and the other by the reliability chapter.
    if (body.__missing) {
      this.notInArchive++;
      return null;
    }
    const text = typeof body.text === "string" ? body.text : "";
    if (!text) {
      this.notInArchive++;
      return null;
    }
    const collapsed = text.replace(/\s+/g, " ");
    const clean = this.maxFetchChars > 0 ? collapsed.slice(0, this.maxFetchChars) : collapsed;
    this.fetchChars += clean.length;
    // The fetch response carries no title; the caller already has one from the search hit.
    return { title: (body.title as string) ?? url, url, body: clean, source: "backsearch" };
  }

  stats(): Record<string, number> {
    // Cost is a first-class counter, not something to reconstruct from an invoice. This arm
    // bills per call, and the failure mode worth catching early is "spent $50, got three hits
    // per query" — which a Brier score prints right through.
    const estCostUsd = this.searches * 0.01 + this.fetches * 0.002;
    const out: Record<string, number> = {
      searches: this.searches,
      searches_failed: this.searchesFailed,
      searches_empty: this.emptySearches,
      dropped_undated: this.undated,
      dropped_after_intraday_anchor: this.afterIntradayAnchor,
      hits_returned: this.hitsReturned,
      candidates_seen: this.candidatesSeen,
      served: this.served,
      fetches: this.fetches,
      fetches_failed: this.fetchesFailed,
      not_in_archive: this.notInArchive,
      fetch_chars: this.fetchChars,
      est_cost_usd: Number(estCostUsd.toFixed(4)),
    };
    for (const [why, count] of this.errors) out[`err:${why}`] = count;
    return out;
  }
}
