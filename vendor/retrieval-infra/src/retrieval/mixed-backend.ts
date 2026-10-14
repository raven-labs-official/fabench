import type { SearchBackend, BackendResult, SearchWithTraceResult } from './search-backend.js';
import type { LeakReviewContext } from './leak-filter.js';
import { EvidenceStore } from './evidence-store.js';

export const MIXED_POLICY = {
  version: 'mixed-half-prefix-v1', frozen: 'ceil(n/2)', web_candidates: 'floor(n/2)',
  selection: 'rank-before-review', refill: false, order: 'frozen-then-web',
  cross_source_deduplication: 'exact-url-frozen-first', review: 'web-only',
} as const;

const key = (url: string, anchor: string, context?: LeakReviewContext) =>
  JSON.stringify([url, anchor, context?.question ?? '', context?.resolutionCriteria ?? '']);

/** Same query and cutoff, fixed disjoint budgets, one response after both finish. */
export class MixedBackend implements SearchBackend {
  readonly name = 'mixed';
  get fullTextResults() { return this.web.fullTextResults; }
  get searchDelivery() { return this.web.searchDelivery; }
  private selected = new Map<string, SearchBackend>();
  private counts = { searches: 0, frozen_requested: 0, web_candidates_requested: 0,
    frozen_returned: 0, web_approved: 0, cross_source_duplicates: 0, served: 0 };
  constructor(private frozen: SearchBackend, private web: SearchBackend, private artifacts: EvidenceStore) {}
  stats() { return { ...this.counts,
    ...Object.fromEntries(Object.entries(this.frozen.stats()).map(([k,v]) => [`frozen_${k}`,v])),
    ...Object.fromEntries(Object.entries(this.web.stats()).map(([k,v]) => [`web_${k}`,v])) }; }
  async search(query: string, n: number, asOf: string) {
    return (await this.searchWithTrace(query,n,asOf)).results;
  }
  async searchWithTrace(query: string, n: number, asOf: string, context?: LeakReviewContext): Promise<SearchWithTraceResult> {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('mixed result count must be a positive integer');
    const frozenN = Math.ceil(n/2), webN = Math.floor(n/2);
    const search = (backend: SearchBackend, count: number): Promise<SearchWithTraceResult> => count === 0
      ? Promise.resolve({results: []}) : backend.searchWithTrace
        ? backend.searchWithTrace(query,count,asOf,context)
        : backend.search(query,count,asOf).then(results => ({results}));
    this.counts.searches++; this.counts.frozen_requested += frozenN; this.counts.web_candidates_requested += webN;
    // Drain both branches even after a fatal error; never return a silent partial
    // treatment or let an outstanding branch write into a closed run.
    const settled = await Promise.allSettled([search(this.frozen,frozenN),search(this.web,webN)]);
    const failure = settled.find(row => row.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const [frozen,web] = settled.map(row => (row as PromiseFulfilledResult<SearchWithTraceResult>).value);
    const results: BackendResult[] = [], seen = new Set<string>();
    let duplicates = 0;
    for (const [packet, backend, cap] of [[frozen!,this.frozen,frozenN],[web!,this.web,webN]] as const) {
      for (const result of packet.results.slice(0,cap)) {
        if (seen.has(result.url)) { duplicates++; continue; }
        seen.add(result.url); results.push(result); this.selected.set(key(result.url,asOf,context),backend);
      }
    }
    const webIds = new Set(results.filter(r => r.source === 'web').map(r => r.documentId ?? r.url));
    const audit = web!.audit ? {...web!.audit, candidates: web!.audit.candidates.map(candidate =>
      candidate.served_to_forecaster && !webIds.has(candidate.document_id ?? candidate.url) ? {...candidate,
        served_to_forecaster: false, final_disposition: 'duplicate_content' as const} : candidate)} : undefined;
    const funnel = web!.funnel ? {...web!.funnel, served: webIds.size} : undefined;
    this.counts.frozen_returned += frozen!.results.length; this.counts.web_approved += web!.results.length;
    this.counts.cross_source_duplicates += duplicates; this.counts.served += results.length;
    this.artifacts.put({operation:'mixed-search', policy:MIXED_POLICY, query, anchor:asOf, context,
      requested:n, frozen_requested:frozenN, web_candidates_requested:webN,
      frozen_returned:frozen!.results.length, web_approved:web!.results.length,
      cross_source_duplicates:duplicates, served:results.length, results, web_audit:audit, web_funnel:funnel});
    return {results,audit,funnel};
  }
  async fetch(url: string, asOf: string) { return (await this.fetchWithTrace(url,asOf)).doc; }
  async fetchWithTrace(url: string, asOf: string, context?: LeakReviewContext) {
    const fetch = (backend: SearchBackend) => backend.fetchWithTrace
      ? backend.fetchWithTrace(url,asOf,context) : backend.fetch(url,asOf).then(doc => ({doc}));
    const selected = this.selected.get(key(url,asOf,context));
    if (selected) return fetch(selected);
    const frozen = await fetch(this.frozen);
    return frozen.doc ? frozen : fetch(this.web);
  }
}
