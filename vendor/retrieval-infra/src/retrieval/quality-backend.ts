import {historicalExcerpt} from './approved-summary.js';
import {timed} from '../observability/timeline.js';
import type { QueryExpander } from './query-expander.js';
import { rankedWork, type RankedWorkOptions } from './ranked-work-queue.js';
import type { BrowseOptions, BrowsePage } from '../corpus/browse.js';
import type { CorpusStore } from '../corpus/store.js';
import type { WikiSnapshot } from '../corpus/wikipedia-cache.js';
import { sameDocumentContent } from '../corpus/query-plan.js';
import { FrozenWorkerPool } from '../corpus/frozen-worker-pool.js';
import { queryFrozen } from '../corpus/frozen-query.js';
export { frozenQueryRoutes } from '../corpus/frozen-query.js';
import { searchTransportCounters, type SearchProvider } from './search-providers.js';
import type { LeakReviewContext } from './leak-filter.js';
import { DocumentReader, type EvidenceDocument } from './document-reader.js';
import type { EvidenceReview } from './evidence-reviewer.js';
import type { ReviewService } from './paired-reviewer.js';
import { EvidenceStore, sha256 } from './evidence-store.js';
import { isMarketHost } from './market-blocklist.js';
import { ProviderApiError } from '../llm/openai-compatible.js';
import { RetrievalInfrastructureError } from './infrastructure-error.js';
import { providerDateCutoff, pageDateProvablyBeforeAnchor, type BackendDoc, type BackendResult,
  type SearchBackend, type SearchWithTraceResult, type FetchWithTraceResult, type RetrievalCandidateAudit, type RetrievalAuditTrace } from './search-backend.js';

export const QUALITY_WEB_EXECUTION_POLICY = { version: 'ranked-review-queue-v3', candidate_concurrency: 8, scheduling: 'rolling', selection: 'provider-rank', reservation: 'active-plus-distinct-completed-successes' } as const;
export type WebExecutionOptions = { candidateConcurrency?: number; scheduling?: RankedWorkOptions['scheduling']; fixedCandidatePrefix?: boolean };
export function webExecutionPolicy(options: WebExecutionOptions = {}) {
  const candidate_concurrency = options.candidateConcurrency ?? QUALITY_WEB_EXECUTION_POLICY.candidate_concurrency;
  const scheduling = options.scheduling ?? QUALITY_WEB_EXECUTION_POLICY.scheduling;
  if (!Number.isSafeInteger(candidate_concurrency) || candidate_concurrency < 1) throw new Error('candidate concurrency must be a positive safe integer');
  if (!['rolling', 'batches'].includes(scheduling)) throw new Error('invalid candidate scheduling');
  return { ...QUALITY_WEB_EXECUTION_POLICY, candidate_concurrency, scheduling,
    ...(options.fixedCandidatePrefix ? { candidate_selection: 'fixed-prefix-no-refill-v1' as const } : {}) };
}

export interface DocumentSlice { documentId: string; fullBodyChars: number; offset: number; nextOffset: number | null; truncated: boolean }
const documentKey = (url: string, anchor: string, context?: LeakReviewContext) => JSON.stringify([url, anchor, context?.question ?? '', context?.resolutionCriteria ?? '']);
const frozenId = (doc: { url: string; title: string; body: string; crawlDate: string }) => sha256(JSON.stringify([doc.url, doc.title, doc.body, doc.crawlDate]));
export function sliceDocument(body: string, documentId: string, offset = 0, maxChars = 0): { text: string } & DocumentSlice {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > body.length || !Number.isSafeInteger(maxChars) || maxChars < 0)
    throw new Error('invalid document slice');
  const end = maxChars ? Math.min(body.length, offset + maxChars) : body.length;
  return { text: body.slice(offset, end), documentId, fullBodyChars: body.length, offset,
    nextOffset: end < body.length ? end : null, truncated: offset > 0 || end < body.length };
}

/** Agent-visible output contains approved documents only; research traces live in artifact storage. */
export class QualityWebBackend implements SearchBackend {
  readonly name = 'web-filter';
  get fullTextResults() { return this.searchDelivery === 'fulltext'; }
  get searchDelivery() { return this.reviewer.searchDelivery; }
  private admitted = new Map<string, EvidenceDocument>();
  private receipts = new Map<string, string>();
  private counts = { searches: 0, fetches: 0, withheld: 0, uncertainty_withheld: 0, leaked_withheld: 0,
    unusable: 0, review_failed: 0, review_cost_usd: 0, evidence_search_requests: 0, evidence_read_calls: 0, evidence_model_calls: 0, review_cache_hits: 0 };
  constructor(private provider: SearchProvider, private reader: DocumentReader, private reviewer: ReviewService,
    private artifacts: EvidenceStore, private returnChars = 0, execution: WebExecutionOptions = {}) { this.executionPolicy = webExecutionPolicy(execution); }
  readonly executionPolicy: ReturnType<typeof webExecutionPolicy>;
  stats() { return { ...this.counts, search_requests: this.provider.stats().requests, search_failed: this.provider.stats().failed, ...searchTransportCounters(this.provider) }; }
  private approved(doc:EvidenceDocument,review:EvidenceReview):EvidenceDocument {
    if(!review.admittedDocumentId)return doc;
    const selected=this.artifacts.get<Omit<EvidenceDocument,'id'>>(review.admittedDocumentId);
    if(selected.url!==doc.url||selected.title!==doc.title||sha256(selected.body)!==selected.bodySha256)throw new Error('Approved document identity mismatch');
    return {...selected,id:review.admittedDocumentId};
  }
  private account(review: EvidenceReview) {
    this.counts.review_cost_usd += review.costUsd; this.counts.evidence_model_calls += review.modelCalls;
    this.counts.evidence_search_requests += review.searchCalls; this.counts.evidence_read_calls += review.readCalls;
    this.counts.review_cache_hits += Number(review.cacheHit);
    if (review.status !== 'supported') { this.counts.withheld++; if (review.status === 'leaked') this.counts.leaked_withheld++; else if (review.failure) this.counts.review_failed++; else this.counts.uncertainty_withheld++; }
  }
  async search(query: string, n: number, asOf: string): Promise<BackendResult[]> {
    return (await this.searchWithTrace(query, n, asOf)).results;
  }
  async searchWithTrace(query: string, n: number, asOf: string, context?: LeakReviewContext): Promise<SearchWithTraceResult> {
    this.counts.searches++;
    const queryStarted=performance.now(),startedAtUtc=new Date().toISOString();
    const fixedPrefix = this.executionPolicy.candidate_selection === 'fixed-prefix-no-refill-v1';
    const providerHits = await timed('search.provider',()=>this.provider.search(query, fixedPrefix ? n : Math.min(40, n * 2), providerDateCutoff(asOf))).catch(error => {
      throw new RetrievalInfrastructureError('search-provider', 'quality_search_failed', 'quality search provider unavailable', { cause: error });
    });
    // Cut before URL/content deduplication, acquisition and review. A provider
    // may return more than requested; none of those extra hits can refill slots.
    const hits = fixedPrefix ? providerHits.slice(0, n) : providerHits;
    const providerMs=performance.now()-queryStarted;
    const candidates: RetrievalCandidateAudit[] = [], results: BackendResult[] = [];
    const seen = new Set<string>(), selected: EvidenceDocument[] = [];
    let cost = 0, reviewed = 0, modelCalls = 0, unknown = 0, leaked = 0, unavailable = 0, cacheHits = 0, failed = 0;
    const unique = hits.flatMap((hit, rank) => {
      if (seen.has(hit.url)) return []; seen.add(hit.url);
      const audit: RetrievalCandidateAudit = { provider_rank: rank + 1, url: hit.url, title: hit.title, snippet: hit.snippet ?? '',
        engine_reported_date: hit.date ?? null, engine_date_decision: 'fetch', page_date_decision: 'not_evaluated',
        final_disposition: 'outside_fetch_window', served_to_forecaster: false };
      candidates.push(audit); return [{ hit, audit }];
    });
    const makeAudit = (error?: string): RetrievalAuditTrace => ({ schema_version: 'raven.retrieval-audit.v1', operation: 'search',
      backend: this.name, provider: this.provider.name, query, anchor_utc: asOf, candidates,
      started_at_utc:startedAtUtc,provider_ms:providerMs,elapsed_ms:performance.now()-queryStarted,
      execution_policy: this.executionPolicy, ...(error ? { operation_error: error } : {}) });
    try {
      await rankedWork(unique, { concurrency: this.executionPolicy.candidate_concurrency, scheduling: this.executionPolicy.scheduling },
        async ({ hit, audit }) => {
        const started = performance.now();audit.started_at_utc=new Date().toISOString();
        try {
          if (isMarketHost(hit.url)) { audit.final_disposition = 'market_host_rejected'; return null; }
          const readStarted = performance.now();
          const doc = await this.reader.read(hit.url, asOf);
          audit.acquisition_ms = performance.now() - readStarted;
          if (!doc) { audit.final_disposition = 'content_unusable'; this.counts.unusable++; unavailable++; return null; }
          // Today's search metadata never enters an approved old document.
          audit.document_id = doc.id;
          audit.page_date_observation = !doc.publishedDate ? 'undated' : pageDateProvablyBeforeAnchor(doc.publishedDate, asOf) ? 'pre-anchor' : 'post-anchor-or-same-day';
          const reviewStarted = performance.now();
          const review = await timed('candidate.review',()=>this.reviewer.review(doc, asOf, context),{candidateId:doc.id});
          audit.review_ms = performance.now() - reviewStarted;
          this.account(review); cost += review.costUsd; reviewed++; modelCalls += review.modelCalls; cacheHits += Number(review.cacheHit);
          audit.evidence_receipt_id = review.receiptId;
          if (review.status !== 'supported') {
            if (review.failure) { failed++; audit.final_disposition = 'review_failed'; audit.review_failure = review.failure; }
            else if (review.status === 'leaked') { leaked++; audit.final_disposition = 'leak_rejected'; }
            else { unknown++; audit.final_disposition = 'uncertainty_rejected'; }
            return null;
          }
          audit.final_disposition = 'passed_but_not_served_limit';
          const approved=this.approved(doc,review); audit.document_id=approved.id;
          return { doc:approved, review };
        } catch (error) {
          audit.final_disposition = 'review_failed';
          audit.operation_error = error instanceof Error ? error.name : 'unknown-error';
          throw error;
        } finally {
          audit.duration_ms = performance.now() - started;
          audit.finished_at_utc=new Date().toISOString();
          // Save each completed candidate even if another page later stalls/fails.
          this.artifacts.put({ operation: 'candidate-review-completed', query, anchor_utc: asOf,
            execution_policy: this.executionPolicy, candidate: audit });
        }

        }, ({ doc, review }, index) => {
          const { audit } = unique[index]!;
          if (selected.some(prior => sameDocumentContent(prior, doc))) {
            audit.final_disposition = 'duplicate_content'; return;
          }
          selected.push(doc);
          const { text, ...slice } = sliceDocument(doc.body, doc.id, 0, this.returnChars);
          const summary=this.searchDelivery==='summary';
          const preview=summary ? doc.searchSummary ?? (['historical-version','registered-source'].includes(review.basis)?historicalExcerpt(doc.body):undefined) : undefined;
          if(summary&&!preview)throw new Error('Approved page has no validated search summary');
          results.push({ title: doc.title, url: doc.url, snippet: preview??text,
            ...(summary?{documentId:doc.id,fullBodyChars:doc.body.length,contentKind:'approved-summary' as const,summaryPolicy:doc.summaryPolicy??'historical-lead-v1'}:slice), source: 'web',
            ...(doc.publishedDate ? { publishDate: doc.publishedDate } : {}),
            ...(doc.availableAt ? { crawlDate: doc.availableAt } : {}) });
          audit.final_disposition = 'served_to_forecaster'; audit.served_to_forecaster = true;
        }, () => n - results.length, (a,b)=>sameDocumentContent(a.doc,b.doc));
    } catch (error) {
      for (const candidate of candidates) {
        if (candidate.served_to_forecaster) candidate.final_disposition = 'passed_but_search_failed';
        candidate.served_to_forecaster = false;
      }
      this.artifacts.put(makeAudit(error instanceof Error ? error.name : 'unknown-error'));
      if (error instanceof ProviderApiError) throw new RetrievalInfrastructureError('leak-filter',
        'evidence_review_provider_failed', 'evidence review provider unavailable', { cause: error });
      throw error;
    }
    // Commit admitted state only once the whole operation can return successfully.
    for (const doc of selected) {
      const audit = candidates.find(c => c.document_id === doc.id && c.served_to_forecaster)!;
      this.admitted.set(documentKey(audit.url, asOf, context), doc); this.admitted.set(documentKey(doc.url, asOf, context), doc);
      this.receipts.set(documentKey(doc.url, asOf, context), audit.evidence_receipt_id!);
    }
    const audit = makeAudit();
    this.artifacts.put(audit);
    return { results, audit, funnel: { backend: this.name, provider: this.provider.name, anchor_utc: asOf,
      provider_date_cutoff: providerDateCutoff(asOf), page_date_policy: 'evidence-reviewed',
      provider_failed: false, requested_results: n, provider_hits: hits.length, engine_date_dropped: 0,
      engine_same_day_rejected: 0, candidates_to_page_dater: reviewed + unavailable, page_records: reviewed,
      pages_dated_pre_anchor: candidates.filter(c => c.page_date_observation === 'pre-anchor').length,
      pages_undated: candidates.filter(c => c.page_date_observation === 'undated').length,
      pages_post_anchor_or_invalid: candidates.filter(c => c.page_date_observation === 'post-anchor-or-same-day').length,
      pages_same_day_rejected: 0, pages_blocked_with_snippet: 0,
      market_hosts_blocked: candidates.filter(c => c.final_disposition === 'market_host_rejected').length,
      leak_reviews: reviewed, leak_review_attempts: modelCalls, leak_dropped: leaked + unknown + failed, uncertainty_dropped: unknown,
      leak_cache_hits: cacheHits, leak_review_failed: failed, leak_cost_usd: cost, served: results.length } };
  }
  async fetch(url: string, asOf: string): Promise<BackendDoc | null> { return (await this.fetchWithTrace(url, asOf)).doc; }
  async fetchWithTrace(url: string, asOf: string, context?: LeakReviewContext): Promise<FetchWithTraceResult> {
    return this.fetchReviewed(url, asOf, context);
  }
  async fetchSlice(url: string, asOf: string, context?: LeakReviewContext, offset = 0, maxChars = this.returnChars): Promise<BackendDoc | null> {
    return (await this.fetchReviewed(url, asOf, context, offset, maxChars)).doc;
  }
  private async fetchReviewed(url: string, asOf: string, context?: LeakReviewContext, offset = 0, maxChars = this.returnChars): Promise<FetchWithTraceResult> {
    this.counts.fetches++;
    const candidate: RetrievalCandidateAudit = { provider_rank: 1, url, title: '', snippet: '', engine_reported_date: null,
      engine_date_decision: 'fetch', page_date_decision: 'not_evaluated', final_disposition: 'content_unusable', served_to_forecaster: false };
    const finish = (doc: BackendDoc | null): FetchWithTraceResult => {
      const audit: RetrievalAuditTrace = { schema_version: 'raven.retrieval-audit.v1', operation: 'fetch', backend: this.name,
        provider: this.provider.name, requested_url: url, anchor_utc: asOf, candidates: [candidate] };
      this.artifacts.put(audit); return { doc, audit };
    };
    let doc = this.admitted.get(documentKey(url, asOf, context));
    if (!doc) {
      const found = await this.reader.read(url, asOf); if (!found) { this.counts.unusable++; return finish(null); }
      let review: EvidenceReview;
      try { review = await this.reviewer.review(found, asOf, context); }
      catch (error) {
        candidate.document_id = found.id; candidate.final_disposition = 'review_failed';
        candidate.operation_error = error instanceof Error ? error.name : 'unknown-error'; finish(null);
        if (error instanceof ProviderApiError) throw new RetrievalInfrastructureError('leak-filter',
          'evidence_review_provider_failed', 'evidence review provider unavailable', { cause: error });
        throw error;
      }
      this.account(review);
      candidate.document_id = found.id; candidate.evidence_receipt_id = review.receiptId;
      if (review.status !== 'supported') {
        candidate.final_disposition = review.failure ? 'review_failed' : review.status === 'leaked' ? 'leak_rejected' : 'uncertainty_rejected';
        if (review.failure) candidate.review_failure = review.failure;
        return finish(null);
      }
      doc = this.approved(found,review); this.admitted.set(documentKey(url, asOf, context), doc); this.admitted.set(documentKey(doc.url, asOf, context), doc);
      this.receipts.set(documentKey(doc.url, asOf, context), review.receiptId);
    }
    candidate.document_id = doc.id; candidate.title = doc.title;
    candidate.evidence_receipt_id = this.receipts.get(documentKey(doc.url, asOf, context));
    candidate.final_disposition = 'served_to_forecaster'; candidate.served_to_forecaster = true;
    const { text, ...slice } = sliceDocument(doc.body, doc.id, offset, maxChars);
    return finish({ title: doc.title, url: doc.url, body: text, ...slice, source: 'web', ...(doc.availableAt ? { crawlDate: doc.availableAt } : {}) });
  }
}

export class QualityFrozenBackend implements SearchBackend {
  readonly name = 'frozen';
  readonly fullTextResults = true;
  private selected = new Map<string, { url: string; title: string; body: string; crawlDate: string }>();
  private searches = 0; private fetches = 0; private browses = 0;
  constructor(private store: CorpusStore | FrozenWorkerPool, private artifacts: EvidenceStore, private returnChars = 0, private wiki?: WikiSnapshot, private expander?: QueryExpander) {}
  async browse(options: BrowseOptions, asOf: string, context?: LeakReviewContext): Promise<BrowsePage> {
    this.browses++;
    const raw = await this.store.browse(options, asOf);
    const page={...raw,results:raw.results.map(doc=>({...doc}))};
    this.artifacts.put({ operation: 'frozen-browse', anchor: asOf, context, request: options, ...page });
    for (const doc of page.results) {
      // Browsing exposes every capture and its full body. URL fetch retains the newest
      // capture seen; older captures remain directly readable in the browse response.
      const key = documentKey(doc.url, asOf, context), prior = this.selected.get(key);
      if (!prior || Date.parse(doc.crawlDate) > Date.parse(prior.crawlDate)) this.selected.set(key, doc);
    }
    return page;
  }
  async search(query: string, n: number, asOf: string): Promise<BackendResult[]> {
    return (await this.searchWithTrace(query, n, asOf)).results;
  }
  async searchWithTrace(query: string, n: number, asOf: string, context?: LeakReviewContext): Promise<SearchWithTraceResult> {
    this.searches++;
    this.wiki?.assertAnchor(asOf);
    const expansion = await this.expander?.expand(query,asOf);
    const searched = this.store instanceof FrozenWorkerPool
      ? await this.store.qualitySearch(query,n,asOf,expansion?.aliases)
      : queryFrozen(this.store,this.wiki,query,n,asOf,expansion?.aliases);
    const result = {...searched,expansion};
    this.artifacts.put({ operation: 'frozen-search', query, anchor: asOf, context, ...result });
    const results: BackendResult[] = result.hits.map(doc => {
      this.selected.set(documentKey(doc.url, asOf, context), doc);
      const documentId = frozenId(doc);
      const { text, ...slice } = sliceDocument(doc.body, documentId, 0, this.returnChars);
      return { title: doc.title, url: doc.url, snippet: text, ...slice, source: 'frozen', crawlDate: doc.crawlDate };
    });
    return { results };
  }
  async fetch(url: string, asOf: string): Promise<BackendDoc | null> { return this.fetchSlice(url, asOf); }
  async fetchWithTrace(url: string, asOf: string, context?: LeakReviewContext): Promise<FetchWithTraceResult> {
    return { doc: await this.fetchSlice(url, asOf, 0, this.returnChars, context) };
  }
  async fetchSlice(url: string, asOf: string, offset = 0, maxChars = this.returnChars, context?: LeakReviewContext): Promise<BackendDoc | null> {
    this.fetches++;
    const doc = this.selected.get(documentKey(url, asOf, context)) ?? this.wiki?.getByUrlBefore(url, asOf) ?? await this.store.getByUrlBefore(url, asOf); if (!doc) return null;
    const documentId = frozenId(doc);
    const { text, ...slice } = sliceDocument(doc.body, documentId, offset, maxChars);
    return { title: doc.title, url: doc.url, body: text, ...slice, source: 'frozen', crawlDate: doc.crawlDate };
  }
  stats() { return { searches: this.searches, fetches: this.fetches, browses: this.browses, ...Object.fromEntries(Object.entries(this.expander?.snapshot() ?? {}).map(([k,v])=>[`query_expansion_${k}`,v])) }; }
}
