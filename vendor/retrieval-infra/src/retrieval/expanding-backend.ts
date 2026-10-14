/**
 * Search each query several ways, then pool the results.
 *
 * WHY THIS AND NOT A WIDER CANDIDATE POOL. The obvious lever looked like the conjunction: the
 * index ANDs the four rarest query terms and relaxes to three and then two, so a document
 * missing one term is excluded. Measured, that lever does nothing. Forcing every rung to run
 * and ranking the union grew the candidate pool from 32 to 46-74 documents and changed the
 * top 8 by ZERO documents on four real queries — because BM25 already scores a document
 * matching four query terms above one matching two, so the extra candidates can never reach
 * the top. Widening the pool does not help when the ranking has already decided.
 *
 * What that measurement rules out is instructive: the documents worth reaching are not the
 * ones that match FEWER of the query's terms, they are the ones that match NONE of them
 * because the writer used different words. Reported vocabulary mismatch for a query term is
 * 40-50% of the documents relevant to that query. A story headlined "truce extended" is
 * unreachable from "ceasefire extension" at any pool size.
 *
 * So the query changes rather than the threshold. Each phrasing is a separate search whose
 * results are pooled; a document reachable from any one of them enters the pool, and the
 * ranking is per-query so no cross-query score comparison is needed — results are interleaved
 * round-robin, taking the first from each phrasing before the second from any.
 *
 * The agent already varies its own wording across its searches, which is a related but
 * different thing: it varies the ANGLE (who, when, which condition) across separate tool
 * calls it decides on, while this varies the WORDING of one angle it already chose.
 */
import type { LlmClient } from "../llm/client.js";
import type { SearchBackend, BackendResult, BackendDoc } from "./search-backend.js";

export interface ExpandStats {
  queries: number;
  variantsGenerated: number;
  /** Results reachable only from a variant, not from the original wording. */
  fromVariantOnly: number;
  failures: number;
  costUsd: number;
}

export class ExpandingBackend implements SearchBackend {
  readonly name: string;
  private readonly cache = new Map<string, string[]>();
  private readonly counts: ExpandStats = {
    queries: 0,
    variantsGenerated: 0,
    fromVariantOnly: 0,
    failures: 0,
    costUsd: 0,
  };

  /**
   * @param variants how many alternative phrasings to ask for. Each one costs a search.
   */
  constructor(
    private readonly inner: SearchBackend,
    private readonly client: LlmClient,
    private readonly variants = 3,
  ) {
    this.name = `${inner.name}+expand`;
  }

  private async phrasings(query: string): Promise<string[]> {
    const hit = this.cache.get(query);
    if (hit) return hit;
    this.counts.queries++;
    let out: string[] = [];
    try {
      const res = await this.client.complete({
        system: "You rewrite search queries. Reply with ONLY the rewritten queries, one per line.",
        prompt: `Rewrite this news-archive search query ${this.variants} different ways.

QUERY: ${query}

The archive is matched on keywords, so a story that says the same thing in different words is
unreachable from the original wording. Each rewrite should name the same event or fact using
DIFFERENT words a journalist might have chosen — synonyms for the action, the other common
name for an organisation or person, the formal term where the query is colloquial and the
colloquial term where it is formal.

Keep each rewrite 3-8 words. Do not add conditions, dates or qualifiers the query does not
have; a rewrite that narrows the query searches for something else. Output ${this.variants}
lines, nothing else.`,
      });
      this.counts.costUsd += res.costUsd;
      out = res.text
        .split("\n")
        .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, "").trim())
        .filter((l) => l.length > 3 && l.length < 120 && !/^(here|rewrit|quer)/i.test(l))
        .slice(0, this.variants);
    } catch {
      // A failed expansion falls back to the original query alone, which is the current
      // behaviour — the arm degrades to the unexpanded backend rather than losing the search.
      this.counts.failures++;
    }
    this.counts.variantsGenerated += out.length;
    this.cache.set(query, out);
    return out;
  }

  async search(query: string, n: number, asOf: string): Promise<BackendResult[]> {
    const alts = await this.phrasings(query);
    const all = [query, ...alts];
    // Every phrasing is searched concurrently: they are independent, and serialising them
    // would make one search cost the sum of four.
    const lists = await Promise.all(all.map((q) => this.inner.search(q, n, asOf).catch(() => [])));

    // Round-robin rather than concatenate. BM25 scores are per-query and not comparable
    // across different term sets, so there is no sound way to merge them by score; taking the
    // best of each phrasing in turn needs no comparison at all.
    //
    // Note what this costs: with `variants` alternatives the original wording supplies only
    // 1/(1+variants) of the slots, so at the default of three it keeps two of the top eight.
    // Measured on four real queries, six of the top eight changed — the new documents were
    // mostly on-topic and reachable no other way ("Tel Aviv, Beirut reportedly reach deal to
    // end Israel's war on Lebanon" for a "ceasefire extension" query), but one query pulled in
    // an unrelated story, which is what drift looks like. Whether that trade is worth making
    // is a question about forecast scores, not about retrieval, so `variants` stays a knob and
    // the run records it.
    const seen = new Set<string>();
    const out: BackendResult[] = [];
    const fromOriginal = new Set((lists[0] ?? []).map((r) => r.url));
    for (let i = 0; out.length < n; i++) {
      let advanced = false;
      for (const list of lists) {
        const r = list[i];
        if (!r || seen.has(r.url)) continue;
        seen.add(r.url);
        out.push(r);
        advanced = true;
        if (out.length >= n) break;
      }
      if (!advanced) break;
    }
    this.counts.fromVariantOnly += out.filter((r) => !fromOriginal.has(r.url)).length;
    return out;
  }

  fetch(url: string, asOf: string): Promise<BackendDoc | null> {
    return this.inner.fetch(url, asOf);
  }

  stats(): Record<string, number> {
    return {
      ...this.inner.stats(),
      expand_queries: this.counts.queries,
      expand_variants: this.counts.variantsGenerated,
      expand_from_variant_only: this.counts.fromVariantOnly,
      expand_failures: this.counts.failures,
      expand_cost_usd: Math.round(this.counts.costUsd * 10000) / 10000,
    };
  }
}
