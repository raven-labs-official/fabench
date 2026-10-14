import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planQuery, type QueryAliases } from '../../vendor/retrieval-infra/src/corpus/query-plan.js';
import { defaultFrozenWorkers } from '../../vendor/retrieval-infra/src/corpus/frozen-execution.js';

/** One current retrieval policy; baseline is an explicit legacy compatibility choice. */
export function retrievalProfile(argv: string[], defaultDirectory: string) {
  const value = (flag: string) => {
    const i = argv.indexOf(`--${flag}`);
    if (i < 0) return undefined;
    if (!argv[i + 1] || argv[i + 1]!.startsWith('--')) throw new Error(`--${flag} requires a value`);
    return argv[i + 1];
  };
  const name = value('retrieval-profile') ?? 'quality-v1';
  if (!['baseline', 'quality-v1'].includes(name)) throw new Error('--retrieval-profile must be baseline or quality-v1');
  const enabled = name === 'quality-v1';
  const browser = value('browser-fallback');
  if (browser !== undefined && !['0','1'].includes(browser)) throw new Error('--browser-fallback must be 0 or 1');
  if (!enabled && browser === '1') throw new Error('--browser-fallback requires quality-v1');
  const concurrency = (flag: string) => {
    const raw = value(flag); if (raw === undefined) return undefined;
    const n = Number(raw); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${flag} must be a positive safe integer`); return n;
  };
  const frozenWorkers=Number(value('frozen-workers')??defaultFrozenWorkers()),frozenQueue=Number(value('frozen-queue')??64);
  const sharedFrozenCachePath=value('shared-frozen-cache'),sharedFrozenCacheSlots=concurrency('frozen-global-slots');
  if(sharedFrozenCacheSlots!==undefined&&(!sharedFrozenCachePath||sharedFrozenCacheSlots>32))throw new Error('--frozen-global-slots requires a shared cache and 1–32 slots');
  if(!Number.isSafeInteger(frozenWorkers)||frozenWorkers<1||frozenWorkers>32)throw new Error('--frozen-workers must be 1–32');
  if(!Number.isSafeInteger(frozenQueue)||frozenQueue<1)throw new Error('--frozen-queue must be a positive safe integer');
  if(!enabled&&(value('frozen-workers')!==undefined||value('frozen-queue')!==undefined||sharedFrozenCachePath))throw new Error('frozen worker options require quality-v1');
  const candidateConcurrency = concurrency('candidate-concurrency'), reviewConcurrency = concurrency('review-concurrency'), cleaningConcurrency = concurrency('cleaning-concurrency'), searchHttpConcurrency = concurrency('search-concurrency');
  const acquisition = {
    fetchConcurrency: concurrency('fetch-concurrency'), readerConcurrency: concurrency('reader-concurrency'),
    readerRpm: concurrency('reader-rpm'), dispatchConcurrency: concurrency('page-dispatch-concurrency'),
  };
  if (!enabled && Object.values(acquisition).some(value => value !== undefined)) throw new Error('acquisition settings require quality-v1');
  const scheduling = value('retrieval-scheduling');
  if (scheduling !== undefined && !['rolling','batches'].includes(scheduling)) throw new Error('--retrieval-scheduling must be rolling or batches');
  if (!enabled && (candidateConcurrency !== undefined || reviewConcurrency !== undefined || cleaningConcurrency !== undefined || searchHttpConcurrency !== undefined || scheduling !== undefined)) throw new Error('retrieval scheduling requires quality-v1');
  const wikiCachePath=value('wiki-cache'),wikiManifestFile=value('wiki-manifest'),wikiIndexFile=value('wiki-index'),queryExpansionModel=value('query-expansion-model');
  const contentProcessing=value('content-processing')??(enabled?'single-pass':'whole-document');
  if(!['whole-document','integrated','single-pass'].includes(contentProcessing))throw new Error('--content-processing must be single-pass, whole-document or integrated');
  // Single-pass review produces the approved summary that formal web runs hand the model.
  const searchDelivery=value('search-delivery')??(enabled&&contentProcessing==='single-pass'?'summary':'fulltext');
  if(!['fulltext','summary'].includes(searchDelivery)||searchDelivery==='summary'&&(!enabled||contentProcessing!=='single-pass'))throw new Error('--search-delivery summary requires quality-v1 single-pass');
  const sourceManifestFile=value('source-manifest'),sharedCacheDirectory=value('shared-review-cache'),fixedDocumentManifestFile=value('fixed-document-manifest');
  const sharedPageCacheDirectory=value('shared-page-cache');
  if(sharedPageCacheDirectory&&(!enabled||contentProcessing!=='single-pass'||!sharedCacheDirectory||sourceManifestFile||fixedDocumentManifestFile))throw new Error('--shared-page-cache requires single-pass quality profile and --shared-review-cache; pinned manifests must be separate');
  if((sharedCacheDirectory||fixedDocumentManifestFile)&&(!enabled||contentProcessing!=='single-pass'))throw new Error('Shared/fixed page caching requires single-pass quality profile');
  if(sourceManifestFile&&(!enabled||contentProcessing!=='single-pass'))throw new Error('--source-manifest requires single-pass content processing');
  if(wikiIndexFile&&!wikiManifestFile)throw new Error('--wiki-index requires --wiki-manifest');
  if(wikiManifestFile&&!wikiCachePath)throw new Error('--wiki-manifest requires --wiki-cache');
  if(!enabled&&(wikiCachePath||wikiManifestFile||wikiIndexFile||queryExpansionModel||contentProcessing!=='whole-document'))throw new Error('architecture options require quality-v1');
  if(queryExpansionModel&&!/^[a-z0-9_-]+:.+/.test(queryExpansionModel))throw new Error('query expansion model requires provider:model');
  const directory = value('retrieval-evidence-dir'), aliasFile = value('retrieval-aliases-file');
  if (!enabled && (directory || aliasFile)) throw new Error('retrieval evidence/aliases options require quality-v1');
  if (enabled) {
    for (const flag of ['date-gate', 'leak-availability-policy', 'web-search-failure-limit', 'web-zero-served-limit']) {
      if (argv.includes(`--${flag}`)) throw new Error(`--${flag} configures the baseline; quality-v1 uses its recorded evidence policy`);
    }
    if (value('leak-filter') === '0') throw new Error('quality-v1 requires the evidence reviewer');
    if (value('fetch-chars') && Number(value('fetch-chars')) !== 0) throw new Error('quality-v1 benchmark tools require --fetch-chars 0 for full reviewed text');
  }
  const aliases: QueryAliases[] = aliasFile ? JSON.parse(readFileSync(aliasFile, 'utf8')) : [];
  if (!Array.isArray(aliases)) throw new Error('retrieval aliases must be an array');
  planQuery('', () => 0, { aliases }); // Validate provenance and bounded groups before paid calls.
  return { searchDelivery: searchDelivery as 'fulltext'|'summary', name: name as 'baseline' | 'quality-v1', enabled,
    wikiCachePath:wikiCachePath?resolve(wikiCachePath):undefined, wikiManifestFile:wikiManifestFile?resolve(wikiManifestFile):undefined, wikiIndexFile:wikiIndexFile?resolve(wikiIndexFile):undefined, queryExpansionModel, contentProcessing:contentProcessing as 'whole-document'|'integrated'|'single-pass',sourceManifestFile:sourceManifestFile?resolve(sourceManifestFile):undefined,
    sharedCacheDirectory:sharedCacheDirectory?resolve(sharedCacheDirectory):undefined,sharedPageCacheDirectory:sharedPageCacheDirectory?resolve(sharedPageCacheDirectory):undefined,fixedDocumentManifestFile:fixedDocumentManifestFile?resolve(fixedDocumentManifestFile):undefined,
    frozenWorkers,frozenQueue,sharedFrozenCacheSlots,sharedFrozenCachePath:sharedFrozenCachePath?resolve(sharedFrozenCachePath):undefined,candidateConcurrency, reviewConcurrency, cleaningConcurrency, searchHttpConcurrency, acquisition, scheduling: scheduling as 'rolling' | 'batches' | undefined,
    directory: enabled ? resolve(directory ?? defaultDirectory) : null, aliases };
}

export function assertQualityCorpus(identity: { kind: string; anchor?: string } | null, anchors: string[]) {
  if (!identity || identity.kind !== 'historical-fts-index') throw new Error('quality-v1 frozen requires a complete historical FTS index');
  if (anchors.some(anchor => new Date(anchor).toISOString() !== identity.anchor))
    throw new Error('quality-v1 frozen index and every question must use the same exact anchor');
}
