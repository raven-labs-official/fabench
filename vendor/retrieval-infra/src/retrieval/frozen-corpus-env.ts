/**
 * RetrievalEnv backed by the frozen corpus store .
 *
 * This is the "past" environment: every search is hard-filtered to content
 * captured at or before `asOf`, so a predictor cannot see the future. Swapping
 * the corpus backend (SQLite FTS5 now, Pyserini later) does not change this contract.
 */
import type { CorpusStore } from "../corpus/store.js";
import type { RetrievalEnv, RetrievalResult } from "../predictors/types.js";

/** Build a short snippet around the first query term, else the head of the body. */
function makeSnippet(body: string, query: string, maxLen = 240): string {
  const terms = query.toLowerCase().match(/[a-z0-9]+/gi) ?? [];
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, at - 40);
  const snippet = body.slice(start, start + maxLen).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + snippet + (start + maxLen < body.length ? "…" : "");
}

export class FrozenCorpusEnv implements RetrievalEnv {
  readonly mode = "past" as const;

  constructor(
    private readonly store: CorpusStore,
    private readonly topK = 10,
  ) {}

  async search(query: string, asOf: string): Promise<RetrievalResult[]> {
    return this.store.search(query, asOf, this.topK).map((hit) => ({
      url: hit.url,
      title: hit.title,
      snippet: makeSnippet(hit.body, query),
      content_timestamp_utc: hit.crawlDate,
      body: hit.body,
    }));
  }

  async validateCitations(
    urls: readonly string[],
    asOf: string,
  ): Promise<{ url: string; valid: boolean; content_timestamp_utc: string | null }[]> {
    return urls.map((url) => {
      const ts = this.store.earliestCrawlBefore(url, asOf);
      return { url, valid: ts != null, content_timestamp_utc: ts };
    });
  }
}
