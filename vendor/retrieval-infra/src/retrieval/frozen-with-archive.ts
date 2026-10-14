import type { LeakReviewContext } from './leak-filter.js';
import type { BrowseOptions, BrowsePage } from '../corpus/browse.js';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { corpusRetrievalIdentity } from '../corpus/retrieval-identity.js';
import { ArchiveSupplementBackend, type VerifiedArchiveDocument } from './archive-supplement.js';
import type { SearchBackend, BackendDoc, BackendResult, SearchWithTraceResult, FetchWithTraceResult } from './search-backend.js';
import { SERIES_CATALOG_POLICY } from './series-catalog.js';

export const FROZEN_ARCHIVE_POLICY = {
  merge: 'preferred-official-source-first-otherwise-news-first-v2',
  source_matching: SERIES_CATALOG_POLICY,
  width: 'total-result-limit-v1',
  fetch: 'latest-pre-anchor-version-v1',
  snippet: 'verified-series-observation-excerpt-v2',
} as const;

/** Explicit union of a historical news index and verified original captures.
 * An official series gets priority for an exact code or a guarded main-data match.
 * Both sources share one result budget; neither performs a network fallback.
 */
export class FrozenWithArchiveBackend implements SearchBackend {
  readonly name = 'frozen-with-archive';
  constructor(private readonly news: SearchBackend, private readonly archive: ArchiveSupplementBackend) {}

  /** Capture browsing enumerates the news index; the separately verified supplement
   * remains available through ordinary search/fetch and its explicit identity. */
  async browse(options: BrowseOptions, asOf: string, context?: LeakReviewContext): Promise<BrowsePage> {
    if (!this.news.browse) throw new Error('browse requires the current frozen backend');
    return this.news.browse(options, asOf, context);
  }

  private validate<T extends BackendResult | BackendDoc>(row: T, asOf: string): T {
    if (row.source !== 'frozen' || !row.crawlDate || !Number.isFinite(Date.parse(row.crawlDate)) ||
        Date.parse(row.crawlDate) >= Date.parse(asOf)) throw new Error('combined frozen source is not strictly pre-anchor');
    return row;
  }

  async search(query: string, n: number, asOf: string): Promise<BackendResult[]> {
    return (await this.searchWithTrace(query, n, asOf)).results;
  }

  async searchWithTrace(query: string, n: number, asOf: string, context?: LeakReviewContext): Promise<SearchWithTraceResult> {
    if (!Number.isInteger(n) || n < 1) throw new Error('positive result count required');
    // Start with the archive's exact-anchor check before querying the larger corpus.
    const archived = await this.archive.search(query, n, asOf);
    const news = this.news.searchWithTrace ? (await this.news.searchWithTrace(query, n, asOf, context)).results : await this.news.search(query, n, asOf);
    const ordered = this.archive.hasPreferredSource(query) ? [...archived, ...news] : [...news, ...archived];
    const chosen = new Map<string, BackendResult>();
    for (const raw of ordered) {
      const row = this.validate(raw, asOf), previous = chosen.get(row.url);
      // Keep position priority, but use the newest verified version of a duplicate URL.
      if (!previous || Date.parse(row.crawlDate!) > Date.parse(previous.crawlDate!)) chosen.set(row.url, row);
    }
    return { results: [...chosen.values()].slice(0, n) };
  }

  async fetch(url: string, asOf: string): Promise<BackendDoc | null> {
    return (await this.fetchWithTrace(url, asOf)).doc;
  }

  async fetchWithTrace(url: string, asOf: string, context?: LeakReviewContext): Promise<FetchWithTraceResult> {
    const archived = await this.archive.fetch(url, asOf);
    const news = this.news.fetchWithTrace ? (await this.news.fetchWithTrace(url, asOf, context)).doc : await this.news.fetch(url, asOf);
    const doc = [archived, news].filter((r): r is BackendDoc => r !== null)
      .map(r => this.validate(r, asOf))
      .sort((a,b) => Date.parse(b.crawlDate!) - Date.parse(a.crawlDate!))[0] ?? null;
    return { doc };
  }

  stats(): Record<string, number> {
    return Object.fromEntries([
      ...Object.entries(this.news.stats()).map(([k,v]) => [`news_${k}`,v]),
      ...Object.entries(this.archive.stats()).map(([k,v]) => [`archive_${k}`,v]),
    ]);
  }
}

/** Validate once, copy the small source pool, and pin its bytes in condition identity. */
export function openFrozenArchive(path: string, corpusPath: string, anchors: readonly string[]) {
  const corpus = corpusRetrievalIdentity(corpusPath);
  if (corpus.kind !== 'historical-fts-index' || !corpus.anchor)
    throw new Error('archive supplement requires a completed historical FTS index');
  if (!anchors.length || anchors.some(a => !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(a) || Date.parse(a) !== Date.parse(corpus.anchor!)))
    throw new Error('archive supplement requires questions at the exact historical index anchor');
  const canonicalPath = realpathSync(path);
  if (statSync(canonicalPath).size > 16 * 1024 * 1024) throw new Error('archive supplement exceeds the 16 MiB small-pool limit');
  const bytes = readFileSync(canonicalPath);
  if (bytes.length > 16 * 1024 * 1024) throw new Error('archive supplement exceeds the 16 MiB small-pool limit');
  const docs: VerifiedArchiveDocument[] = bytes.toString('utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
  if (!docs.length) throw new Error('archive supplement is empty');
  const backend = new ArchiveSupplementBackend(docs, corpus.anchor);
  return {
    backend,
    identity: {
      schema: 'raven.frozen-archive-treatment.v1', path: canonicalPath,
      file_sha256: createHash('sha256').update(bytes).digest('hex'),
      document_count: docs.length, anchor: corpus.anchor,
      verified_documents_identity: backend.identity, policy: FROZEN_ARCHIVE_POLICY,
    },
    close: () => backend.close(),
  };
}
