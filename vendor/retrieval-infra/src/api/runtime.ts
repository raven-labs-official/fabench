import { QueryExpander } from '../retrieval/query-expander.js';
import { SourceManifest } from '../retrieval/source-manifest.js';
import { FixedDocumentManifest } from '../retrieval/fixed-document-manifest.js';
import { WikipediaCache, type WikiSnapshot } from '../corpus/wikipedia-cache.js';
import { join } from 'node:path';
import { FrozenWorkerPool, type FrozenPoolOptions } from '../corpus/frozen-worker-pool.js';
import type { CorpusStore } from '../corpus/store.js';
import type { LlmClient } from '../llm/client.js';
import type { SearchProvider } from '../retrieval/search-providers.js';
import { PageDater, type PageAcquisitionOptions } from '../retrieval/page-dater.js';
import { EvidenceStore } from '../retrieval/evidence-store.js';
import { DocumentReader, DOCUMENT_POLICY } from '../retrieval/document-reader.js';
import { EvidenceReviewer, type EvidenceReviewOptions } from '../retrieval/evidence-reviewer.js';
import { PairedReviewer } from '../retrieval/paired-reviewer.js';
import { ReaderCleaner, type ReaderCleanerOptions } from '../retrieval/reader-cleaner.js';
import { QualityFrozenBackend, QualityWebBackend, type WebExecutionOptions } from '../retrieval/quality-backend.js';
import { MixedBackend } from '../retrieval/mixed-backend.js';
import { projectEnv } from "../env-names.js";

export const RETRIEVAL_PROFILE = 'quality-v1' as const;
export type RetrievalRuntimeOptions = {
  fixedDocumentManifestFile?:string; sharedCacheDirectory?:string; sharedPageCacheDirectory?:string;
  store?: CorpusStore | FrozenWorkerPool; frozen?:FrozenPoolOptions; queryExpansionClient?: LlmClient; wikiSnapshot?: WikiSnapshot; wikiCachePath?: string; artifacts?: EvidenceStore; evidenceDirectory?: string;
  dater?: PageDater; provider?: SearchProvider; reviewerClient?: LlmClient; shadowReviewerClient?: LlmClient;
  acquisition?: PageAcquisitionOptions;
  webExecution?: WebExecutionOptions; reviewOptions?: EvidenceReviewOptions; returnChars?: number; reader?: boolean; browser?: boolean;
  cleanerClient?: LlmClient; cleaningOptions?: ReaderCleanerOptions;
};

/** The CLI and experiment harness share this assembly and its evidence-review cache.
 * Injected resources stay caller-owned; each backend owns only its per-condition counters.
 * Constructing a runtime performs no network requests or model calls.
 */
export function createRetrievalRuntime(options: RetrievalRuntimeOptions = {}) {
  if(options.store&&options.frozen)throw new Error('Supply either an injected store or frozen pool options');
  if(options.dater&&options.acquisition)throw new Error('Configure acquisition on the injected PageDater, not twice');
  const returnChars = options.returnChars ?? 0;
  if (!Number.isSafeInteger(returnChars) || returnChars < 0) throw new Error('returnChars must be a nonnegative integer');
  const artifacts = options.artifacts ?? new EvidenceStore(options.evidenceDirectory ??
    projectEnv("FABENCH_RETRIEVAL_EVIDENCE_DIR") ?? join(projectEnv("FABENCH_RESULTS_DIR") ?? join(process.cwd(), 'results'), 'retrieval-artifacts'));
  const dater = options.dater ?? new PageDater(options.reader ?? true, undefined, undefined, undefined,
    { policy: DOCUMENT_POLICY, rawDirectory: join(artifacts.directory, 'raw'), browser: options.browser ?? false }, options.acquisition);
  const processing=options.reviewOptions?.processing??'single-pass';
  if(options.shadowReviewerClient && (!options.reviewerClient || !options.provider || processing!=='single-pass'))
    throw new Error('Shadow review requires a primary single-pass web reviewer');
  if(options.sharedPageCacheDirectory && (processing!=='single-pass' || options.fixedDocumentManifestFile || options.reviewOptions?.sourceManifestFile))
    throw new Error('Shared page snapshots require single-pass processing without a pinned manifest');
  const cleaningClient = options.cleanerClient ?? options.reviewerClient;
  const cleaner = processing==='whole-document' && cleaningClient ? new ReaderCleaner(cleaningClient, artifacts,
    { cacheDirectory: join(artifacts.directory, 'cleaning-cache'), ...options.cleaningOptions }) : undefined;
  const wikiCache = options.wikiCachePath ? new WikipediaCache(options.wikiCachePath) : undefined;
  const sources=options.reviewOptions?.sourceManifestFile?new SourceManifest(options.reviewOptions.sourceManifestFile):undefined;
  const fixed=options.fixedDocumentManifestFile?new FixedDocumentManifest(options.fixedDocumentManifestFile):undefined;
  const reader = new DocumentReader(urls => dater.fetchMany(urls), artifacts, undefined, cleaner, dater.configuration(), wikiCache, sources,fixed,options.sharedPageCacheDirectory);
  const primaryReviewer = options.provider && options.reviewerClient ? new EvidenceReviewer(options.reviewerClient,
    options.provider, reader, artifacts, { cacheDirectory: join(artifacts.directory, 'review-cache'),sharedCacheDirectory:options.sharedCacheDirectory, ...options.reviewOptions,processing }) : undefined;
  const shadowReviewer = options.provider && options.shadowReviewerClient ? new EvidenceReviewer(options.shadowReviewerClient,
    options.provider, reader, artifacts, { ...options.reviewOptions, processing,
      cacheDirectory:join(artifacts.directory,'shadow-review-cache'),sharedCacheDirectory:options.sharedCacheDirectory }) : undefined;
  const reviewer = primaryReviewer && shadowReviewer ? new PairedReviewer(primaryReviewer,shadowReviewer,artifacts) : primaryReviewer;
  const expander = options.queryExpansionClient ? new QueryExpander(options.queryExpansionClient,artifacts,join(artifacts.directory,'query-expansion-cache')) : undefined;
  const store=options.store??(options.frozen?new FrozenWorkerPool(options.frozen):undefined);
  const backends: (QualityFrozenBackend | QualityWebBackend | MixedBackend)[] = [];
  let closed = false;
  function createBackend(mode: 'frozen'): QualityFrozenBackend;
  function createBackend(mode: 'web-filter'): QualityWebBackend;
  function createBackend(mode: 'mixed'): MixedBackend;
  function createBackend(mode: 'frozen' | 'web-filter'): QualityFrozenBackend | QualityWebBackend;
  function createBackend(mode: 'frozen' | 'web-filter' | 'mixed'): QualityFrozenBackend | QualityWebBackend | MixedBackend {
      if (closed) throw new Error('retrieval runtime is closed');
      let backend: QualityFrozenBackend | QualityWebBackend | MixedBackend;
      if (mode === 'mixed') {
        if (!store || !options.provider || !reviewer) throw new Error('mixed requires frozen corpus, search provider and reviewer client');
        backend = new MixedBackend(new QualityFrozenBackend(store,artifacts,returnChars,options.wikiSnapshot,expander),
          new QualityWebBackend(options.provider,reader,reviewer,artifacts,returnChars,{...options.webExecution,fixedCandidatePrefix:true}),artifacts);
      } else if (mode === 'frozen') {
        if (!store) throw new Error('frozen mode requires a corpus store');
        backend = new QualityFrozenBackend(store, artifacts, returnChars, options.wikiSnapshot, expander);
      } else if (mode === 'web-filter') {
        if (!options.provider || !reviewer) throw new Error('web-filter requires a search provider and reviewer client');
        backend = new QualityWebBackend(options.provider, reader, reviewer, artifacts, returnChars, options.webExecution);
      } else throw new Error('unsupported mode');
      backends.push(backend); return backend;
    }
  return {
    store, artifacts, dater, reader, reviewer, shadowReviewer, cleaner, expander, fixedDocuments:fixed?.identity??null, sharedPageSnapshot:reader.sharedPageIdentity, provider: options.provider, createBackend,
    stats: () => ({ ...Object.fromEntries(backends.flatMap((backend, index) =>
      Object.entries(backend.stats()).map(([key, value]) => [`${backend.name}_${index}_${key}`, value]))),
      ...Object.fromEntries(Object.entries(cleaner?.snapshot() ?? {}).map(([key, value]) => [`reader_cleaning_${key}`, value])),
      ...Object.fromEntries(Object.entries(reader.snapshot()).map(([key,value])=>[`reader_${key}`,value])) }),
    close: () => { if (!closed) { closed = true; reviewer?.close(); reader.close(); if(!options.store)store?.close(); wikiCache?.close(); if (!options.dater) dater.close(); } },
  };
}
