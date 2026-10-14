import {withTiming,timed,timingContext} from '../observability/timeline.js';
import { readFileSync } from 'node:fs';
import { WikipediaCache, WikiSnapshot } from '../corpus/wikipedia-cache.js';
import { FrozenWorkerPool } from '../corpus/frozen-worker-pool.js';
import { corpusRetrievalIdentity } from '../corpus/retrieval-identity.js';
import { FROZEN_QUERY_POLICY } from '../corpus/query-identity.js';
import { FrozenBackend, WebSearchBackend, type SearchBackend } from '../retrieval/search-backend.js';
import { FrozenWithArchiveBackend, openFrozenArchive } from '../retrieval/frozen-with-archive.js';
import { LeakFilter, type LeakReviewContext } from '../retrieval/leak-filter.js';
import { PageDater } from '../retrieval/page-dater.js';
import { createSearchProvider, BRAVE_SEARCH_CONFIG, configureSearchHttpConcurrency } from '../retrieval/search-providers.js';
import { createLlmClient } from '../llm/providers.js';
import { DOCUMENT_POLICY } from '../retrieval/document-reader.js';
import type { EvidenceReviewOptions } from '../retrieval/evidence-reviewer.js';
import { QualityFrozenBackend, QualityWebBackend, type WebExecutionOptions } from '../retrieval/quality-backend.js';
import { CONCEPT_QUERY_POLICY, type QueryAliases } from '../corpus/query-plan.js';
import type { BrowseOptions } from '../corpus/browse.js';
import { createRetrievalRuntime, RETRIEVAL_PROFILE } from './runtime.js';

export type RetrievalSessionOptions = {
  fixedDocumentManifestFile?:string;sharedCacheDirectory?:string;frozenWorkers?:number; frozenQueue?:number; mode: 'frozen' | 'web-filter'; asOf: string; wikiCachePath?: string; wikiManifestFile?: string; wikiIndexFile?: string; queryExpansionModel?: string; corpusPath?: string; archiveFile?: string;
  reviewer?: string; searchProvider?: string; searchHttpConcurrency?: number; reader?: boolean; browser?: boolean; context?: LeakReviewContext;
  profile?: 'baseline' | 'quality-v1'; evidenceDirectory?: string; returnChars?: number;
  queryAliases?: QueryAliases[]; evidenceReview?: EvidenceReviewOptions; webExecution?: WebExecutionOptions; cleaningConcurrency?: number;
};

export function exactAnchor(asOf: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(asOf) || !Number.isFinite(Date.parse(asOf)))
    throw new Error('asOf must be an exact timestamp with timezone');
  return new Date(asOf).toISOString();
}

/** A run owns one session. Only admitted text leaves search/fetch; review traces stay separate. */
export function createRetrievalSession(options: RetrievalSessionOptions) {
  const asOf = exactAnchor(options.asOf);
  const context = structuredClone(options.context ?? {});
  if (options.profile && !['baseline', 'quality-v1'].includes(options.profile)) throw new Error('invalid retrieval profile');
  const profile = options.profile ?? RETRIEVAL_PROFILE;
  const quality = profile === RETRIEVAL_PROFILE;
  const returnChars = options.returnChars ?? 0;
  if (!Number.isSafeInteger(returnChars) || returnChars < 0) throw new Error('returnChars must be a nonnegative integer');
  if (!quality && (options.fixedDocumentManifestFile || options.sharedCacheDirectory || options.evidenceDirectory || options.returnChars !== undefined || options.queryAliases || options.evidenceReview || options.webExecution || options.cleaningConcurrency !== undefined || options.queryExpansionModel || options.wikiCachePath || options.wikiManifestFile || options.wikiIndexFile || options.browser !== undefined)) throw new Error('quality options require profile quality-v1');
  let runtime: ReturnType<typeof createRetrievalRuntime> | undefined;
  let backend: SearchBackend;
  let close: () => void;
  let identity: Record<string, unknown>;
  if(options.mode==='frozen'&&(options.fixedDocumentManifestFile||options.sharedCacheDirectory))throw new Error('Shared web caches require web-filter mode');
  if(options.mode==='web-filter'&&(options.frozenWorkers!==undefined||options.frozenQueue!==undefined))throw new Error('Frozen worker options require frozen mode');
  if (options.mode === 'frozen' && options.searchHttpConcurrency !== undefined) throw new Error('Search HTTP concurrency requires web-filter mode');
  if (options.mode === 'frozen') {
    if (!options.corpusPath) throw new Error('frozen mode requires corpusPath');
    const corpus = corpusRetrievalIdentity(options.corpusPath);
    if (corpus.kind !== 'historical-fts-index' || corpus.anchor !== asOf)
      throw new Error('frozen session requires a complete historical index at the exact anchor');
    const store = new FrozenWorkerPool({corpusPath:options.corpusPath,strategy:quality?'concept':'rarity',aliases:options.queryAliases,workers:options.frozenWorkers,maxQueue:options.frozenQueue,wikiCachePath:options.wikiCachePath,wikiManifestFile:options.wikiManifestFile,wikiIndexFile:options.wikiIndexFile});
    let archive: ReturnType<typeof openFrozenArchive> | undefined;
    let wiki: WikiSnapshot | undefined;
    try {
      if (options.wikiManifestFile) {
        if (!quality || !options.wikiCachePath) throw new Error('Wiki snapshot requires quality profile and cache path');
        const cache = new WikipediaCache(options.wikiCachePath, true);
        try { wiki = new WikiSnapshot(cache,JSON.parse(readFileSync(options.wikiManifestFile,'utf8')),options.wikiIndexFile); wiki.assertAnchor(asOf); } finally { cache.close(); }
      }
      archive = options.archiveFile ? openFrozenArchive(options.archiveFile, options.corpusPath, [asOf]) : undefined;
      runtime = quality ? createRetrievalRuntime({ store, wikiSnapshot:wiki, queryExpansionClient: options.queryExpansionModel ? createLlmClient(options.queryExpansionModel) : undefined, evidenceDirectory: options.evidenceDirectory, returnChars }) : undefined;
      const news = runtime ? runtime.createBackend('frozen') : new FrozenBackend(store);
      backend = archive ? new FrozenWithArchiveBackend(news, archive.backend) : news;
      identity = { mode: options.mode, as_of: asOf, corpus, frozen_execution:store.execution, query_policy: quality ? CONCEPT_QUERY_POLICY : FROZEN_QUERY_POLICY,
        ...(quality ? { profile, retrieval_entrypoint: 'createRetrievalRuntime', search_content: 'full-stored-text', return_chars: returnChars, query_aliases: options.queryAliases ?? [], wiki_snapshot:wiki?.identity ?? null, query_expansion:runtime?.expander?.configuration() ?? null } : {}),
        ...(archive ? { archive: archive.identity } : {}) };
      close = () => { runtime?.close(); archive?.close(); wiki?.close(); store.close(); };
    } catch (error) { runtime?.close(); archive?.close(); wiki?.close(); store.close(); throw error; }
  } else if (options.mode === 'web-filter') {
    if (options.queryExpansionModel) throw new Error('query expansion currently belongs to frozen mode');
    if (options.archiveFile || options.wikiManifestFile || options.wikiIndexFile) throw new Error('archiveFile/wikiManifestFile belongs to frozen mode');
    const reviewer = options.reviewer ?? 'deepseek:deepseek-flash';
    const searchHttpPolicy = configureSearchHttpConcurrency(options.searchHttpConcurrency);
    const provider = createSearchProvider(options.searchProvider ?? 'serper');
    const client = createLlmClient(reviewer);
    if (quality) {
      runtime = createRetrievalRuntime({ fixedDocumentManifestFile:options.fixedDocumentManifestFile,sharedCacheDirectory:options.sharedCacheDirectory,provider, reviewerClient: client, evidenceDirectory: options.evidenceDirectory,
        wikiCachePath: options.wikiCachePath, reviewOptions: options.evidenceReview, webExecution: options.webExecution, cleaningOptions: { concurrency: options.cleaningConcurrency }, returnChars, reader: options.reader, browser: options.browser });
      backend = runtime.createBackend('web-filter');
      identity = { mode: options.mode, as_of: asOf, profile, retrieval_entrypoint: 'createRetrievalRuntime', reviewer,
        search_provider: provider.name, search_http_policy: searchHttpPolicy, ...(provider.name === 'brave' ? { provider_config: BRAVE_SEARCH_CONFIG } : {}), content_policy: DOCUMENT_POLICY, date_gate: 'retrieved-evidence',
        evidence_review: runtime.reviewer!.configuration(), execution_policy: (backend as QualityWebBackend).executionPolicy,
        reader_cleaning: runtime.cleaner?.configuration()??null,
        page_acquisition: runtime.dater.configuration(),fixed_documents:runtime.fixedDocuments,
        search_delivery: runtime.reviewer!.searchDelivery, return_chars: returnChars, wikipedia: 'pre-anchor-revision', reader: options.reader ?? true };
    } else {
      const dater = new PageDater(options.reader ?? true);
      const filter = new LeakFilter(client, { availabilityPolicy: 'component-availability-v5' });
      backend = new WebSearchBackend(provider, dater, filter, undefined, 'content');
      identity = { mode: options.mode, as_of: asOf, reviewer, search_provider: provider.name, search_http_policy: searchHttpPolicy, ...(provider.name === 'brave' ? { provider_config: BRAVE_SEARCH_CONFIG } : {}),
        availability_policy: 'component-availability-v5', date_gate: 'content', reader: options.reader ?? true };
      close = () => dater.close();
    }
    if (runtime) close = () => runtime!.close();
  } else throw new Error('unsupported mode');
  let closed = false;
  const open = () => { if (closed) throw new Error('retrieval session is closed'); };
  const measured=<T>(stage:string,work:()=>Promise<T>)=>timingContext()?timed(stage,work):withTiming({},event=>{runtime?.artifacts.put({operation:'stage-timing',event});},()=>timed(stage,work));
  return {
    identity: structuredClone(identity),
    async search(query: string, n = 10) {
      open();
      if (typeof query !== 'string' || !query.trim() || query.length > 4000) throw new Error('query must contain 1–4000 characters');
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('n must be an integer from 1 to 20');
      return measured('search',async()=>backend.searchWithTrace ? (await backend.searchWithTrace(query, n, asOf, context)).results : backend.search(query, n, asOf));
    },
    async browse(browseOptions: BrowseOptions) {
      open();
      if (!backend.browse) throw new Error('browse requires the current frozen backend');
      return measured('browse',()=>backend.browse!(browseOptions, asOf, context));
    },
    async fetch(url: string, offset = 0, maxChars = returnChars) {
      open();
      if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('fetch requires an HTTP(S) URL');
      return measured('fetch',async()=>{
      if (backend instanceof QualityWebBackend) return backend.fetchSlice(url, asOf, context, offset, maxChars);
      if (backend instanceof QualityFrozenBackend) return backend.fetchSlice(url, asOf, offset, maxChars, context);
      if (offset || maxChars) throw new Error('paged fetch requires a quality backend without archive supplement');
      return backend.fetchWithTrace ? (await backend.fetchWithTrace(url, asOf, context)).doc : backend.fetch(url, asOf);
      });
    },
    stats: () => ({ ...backend.stats(), ...Object.fromEntries(Object.entries(runtime?.cleaner?.snapshot() ?? {}).map(([key, value]) => [`reader_cleaning_${key}`, value])) }),
    close: () => { if (!closed) { closed = true; close(); } },
  };
}
