import { resolveWikiDocument, WIKIPEDIA_RESOLUTION_POLICY, WikiCacheIntegrityError, type WikipediaCache } from '../corpus/wikipedia-cache.js';
import { EvidenceStore, sha256 } from './evidence-store.js';
import type { DatedPage } from './page-dater.js';
import { isMarketHost } from './market-blocklist.js';
import { RetrievalInfrastructureError } from './infrastructure-error.js';
import { HISTORICAL_USER_AGENT } from '../http-identity.js';
import type { ReaderCleaner } from './reader-cleaner.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SharedArtifactCache } from './shared-artifact-cache.js';
import type { SourceManifest } from './source-manifest.js';
import type { FixedDocumentManifest } from './fixed-document-manifest.js';
import {timed,timingSpan} from '../observability/timeline.js';
import { SharedRateLimiter, sharedRateLimiter, WIKIMEDIA_API_LIMIT } from '../llm/shared-rate-limit.js';

export const DOCUMENT_POLICY = 'article-blocks-tables-v1';
export const SHARED_PAGE_POLICY = 'first-successful-snapshot-url-anchor-v1';
export interface EvidenceDocument {
  id: string; url: string; title: string; body: string; bodySha256: string;
  acquiredAt: string; publishedDate: string | null;
  temporalBasis: 'live-page' | 'wikipedia-revision' | 'registered-source';
  availableAt?: string; version?: string; provenanceId: string;
  cleaningReceiptId?: string;
  searchSummary?: string; summaryPolicy?: string;
}
export type FetchPages = (urls: readonly string[]) => Promise<DatedPage[]>;
export type Download = (url: string) => Promise<string>;

let localWikiLimiter: SharedRateLimiter | undefined;
export const downloadJson: Download = async url => {
  if (!/^https:\/\/[a-z-]+\.wikipedia\.org\/w\/api\.php\?/.test(url)) throw new Error('Expected Wikipedia Action API endpoint');
  const limiter = sharedRateLimiter() ?? (localWikiLimiter ??= new SharedRateLimiter(join(homedir(), '.cache', 'raven', 'wikimedia-admission.sqlite')));
  for (let attempt = 0; attempt < 3; attempt++) {
    const admission=timingSpan('wiki.shared_queue');admission.queued();
    let permit;
    try { permit=await limiter.acquire(WIKIMEDIA_API_LIMIT.resource);admission.admitted();admission.start();admission.end(); }
    catch(error) { admission.end(error);throw error; }
    const http=timingSpan('wiki.http');http.start();let success = false;
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(permit.signal ? [permit.signal] : [])]),
        headers: { 'User-Agent': HISTORICAL_USER_AGENT } });
      if (!response.ok) {
        await response.body?.cancel();
        http.end(Object.assign(new Error(`historical API HTTP ${response.status}`),{name:`HTTP${response.status}`}));
        if (response.status === 429 || response.status === 503) {
          permit.limited(response.headers.get('retry-after'));
          if (attempt < 2) continue; // Next admission respects the shared cooldown.
        }
        throw new Error(`historical API HTTP ${response.status}`);
      }
      const reader = response.body?.getReader(); if (!reader) throw new Error('empty API response');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 5_000_000) throw new Error('historical API response too large'); chunks.push(value); }
      } finally { await reader.cancel(); }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      success = true; return text;
    } catch(error) { http.end(error);throw error; }
    finally { http.end();permit.release(success); }
  }
  throw new Error('Historical API retries exhausted');
};

export class UnsupportedWikipediaUrlError extends Error {
  constructor(url:string) { super(`unsupported Wikipedia article URL: ${url}`); this.name='UnsupportedWikipediaUrlError'; }
}

export function wikipediaTarget(url: string): { host: string; title?: string; revision?: string } | null {
  const parsed = new URL(url);
  const match = /^([a-z-]+)(?:\.m)?\.wikipedia\.org$/.exec(parsed.hostname);
  if (!match) return null;
  const host = `https://${match[1]}.wikipedia.org`;
  // MediaWiki's language-variant URLs (zh-tw, sr-el, kk-cyrl, …) select
  // presentation. Resolve the same title through the anchor's revision API.
  const [,route,...parts]=parsed.pathname.split('/');
  if(route==='wiki'||route===match[1]||route?.startsWith(match[1]+'-')) {
    try {
      const title=decodeURIComponent(parts.join('/')).replaceAll('_',' ').trim();
      if(title)return {host,title};
    } catch { throw new UnsupportedWikipediaUrlError(url); }
  }
  if (parsed.pathname === '/w/index.php' && /^\d+$/.test(parsed.searchParams.get('oldid') ?? '')) return { host, revision: parsed.searchParams.get('oldid')! };
  if (parsed.pathname === '/w/index.php' && parsed.searchParams.get('title')) return { host, title: parsed.searchParams.get('title')! };
  throw new UnsupportedWikipediaUrlError(url);
}

/** Output storage location is recorded by PageDater, but must not change treatment/cache identity. */
export function readerAcquisitionIdentity(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
  const config = value as Record<string, unknown>, content = config.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return value;
  const {rawDirectory: _outputPath, ...policy} = content as Record<string, unknown>;
  return {...config, content: policy};
}

/** Version recovery is source-specific. An ordinary live page is never labeled an old version. */
export class DocumentReader {
  private cache = new Map<string, Promise<EvidenceDocument | null>>();
  private sharedPages?: SharedArtifactCache;
  readonly sharedPageIdentity: {policy:string; namespace_sha256:string} | null;
  private sharedHits = 0;
  private sharedMisses = 0;
  readonly failures: { url: string; reason: string }[] = [];
  constructor(private fetchPages: FetchPages, readonly artifacts: EvidenceStore, private get: Download = downloadJson,
    private cleaner?: Pick<ReaderCleaner, 'clean'> & Partial<Pick<ReaderCleaner, 'configuration'>>, private acquisition?: unknown, private wikiCache?: WikipediaCache,
    private sourceManifest?:SourceManifest,private fixedDocuments?:FixedDocumentManifest,sharedPageDirectory?:string) {
    if(sharedPageDirectory && (cleaner || sourceManifest || fixedDocuments)) throw new Error('Shared live snapshots cannot be combined with cleaning or pinned source manifests');
    this.sharedPageIdentity = sharedPageDirectory ? {policy:SHARED_PAGE_POLICY,namespace_sha256:sha256(resolve(sharedPageDirectory))} : null;
    if(sharedPageDirectory)this.sharedPages = new SharedArtifactCache(sharedPageDirectory);
  }
  configuration() { return { content_policy:DOCUMENT_POLICY, wikipedia_api_limit:WIKIMEDIA_API_LIMIT, wikipedia_resolution:WIKIPEDIA_RESOLUTION_POLICY, wikipedia_cache:this.wikiCache ? 'immutable-revision-exact-anchor-v1' : null, acquisition:readerAcquisitionIdentity(this.acquisition), cleaning:this.cleaner?.configuration?.() ?? null,
    ...(this.sharedPageIdentity?{shared_page_snapshot:this.sharedPageIdentity}:{}) }; }
  snapshot() { return {sharedPageHits:this.sharedHits,sharedPageMisses:this.sharedMisses}; }
  close() { this.sharedPages?.close(); }
  read(url: string, anchor: string): Promise<EvidenceDocument | null> {
    if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(anchor) || !Number.isFinite(Date.parse(anchor))) throw new Error('historical reading requires an exact anchor');
    let parsed:URL;
    try { parsed=new URL(url); }
    catch { this.failures.push({url,reason:'invalid document URL'}); return Promise.resolve(null); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || isMarketHost(url)) return Promise.resolve(null);
    const key = JSON.stringify([url, anchor]);
    const existing = this.cache.get(key); if (existing) return existing;
    const pending = timed('document.acquire',async()=>{
      if(!this.sharedPages)return this.acquire(url,anchor);
      // The explicit pool fixes the first successful capture for each URL/anchor.
      // Different extraction policies never share a capture. This does not prove
      // historical availability: the ordinary temporal review still runs.
      const sharedKey=sha256(JSON.stringify({url,anchor,reader:this.configuration()}));
      const result=await this.sharedPages.run(sharedKey,this.artifacts,()=>this.acquire(url,anchor),doc=>doc!==null);
      if(result.reused)this.sharedHits++;else this.sharedMisses++;
      return result.value;
    }).then(doc=>{if(!doc)this.cache.delete(key);return doc;}).catch(error => { this.cache.delete(key); throw error; });
    this.cache.set(key, pending); return pending;
  }
  private save(value: Omit<EvidenceDocument, 'id'>): EvidenceDocument {
    const id = this.artifacts.put(value); return { ...value, id };
  }
  private async acquire(url: string, anchor: string): Promise<EvidenceDocument | null> {
    try{
      const registered=this.sourceManifest?.read(url,anchor,this.artifacts);
      if(registered)return registered;
      const fixed=this.fixedDocuments?.read(url,anchor,this.artifacts);if(fixed)return fixed;
    }catch(error){throw new RetrievalInfrastructureError('page-dater','source_cache_corrupt','Pinned source failed integrity validation',{cause:error});}
    let target:ReturnType<typeof wikipediaTarget>;
    try { target=wikipediaTarget(url); }
    catch(error) {
      if(!(error instanceof UnsupportedWikipediaUrlError))throw error;
      this.failures.push({url,reason:error.message});return null;
    }
    if (target) {
      try {
        const {revision,redirects} = await resolveWikiDocument(target,anchor,this.get,this.wikiCache);
        const { raw, acquiredAt, body, title, availableAt, version, cachedAt } = revision;
        const redirectProofs=redirects.map(d=>this.artifacts.put({endpoint:d.endpoint,raw:d.raw,acquiredAt:d.acquiredAt,cachedAt:d.cachedAt,source:'mediawiki-api',version:d.version,availableAt:d.availableAt,redirectTarget:d.redirectTarget}));
        const provenanceId = this.artifacts.put({ endpoint: revision.endpoint, raw, acquiredAt, cachedAt, source: 'mediawiki-api',
          ...(redirectProofs.length?{requestedUrl:url,redirectProofs,resolutionPolicy:WIKIPEDIA_RESOLUTION_POLICY}:{}) });
        return this.save({ url: `${target.host}/w/index.php?oldid=${version}`, title, body, bodySha256: sha256(body),
          acquiredAt, publishedDate: null, temporalBasis: 'wikipedia-revision', availableAt, version, provenanceId });
      } catch (error) {
        if(error instanceof WikiCacheIntegrityError)throw new RetrievalInfrastructureError('page-dater','wiki_cache_corrupt','Wiki revision cache failed integrity validation',{cause:error});
        this.failures.push({ url, reason: error instanceof Error ? error.message : 'historical read failed' });
        return null; // No fallback to today's Wikipedia text.
      }
    }
    const page = (await this.fetchPages([url]))[0];
    if (!page) return null;
    if (page.quality_error) throw new RetrievalInfrastructureError('page-dater', 'content_processing_failed', page.quality_error);
    const acquiredAt = new Date().toISOString();
    const provenanceId = this.artifacts.put({ page, acquiredAt });
    const finalUrl = page.final_url ?? page.url;
    if (isMarketHost(finalUrl)) return null;
    try { if(wikipediaTarget(finalUrl))return this.read(finalUrl,anchor); }
    catch(error) {
      if(!(error instanceof UnsupportedWikipediaUrlError))throw error;
      this.failures.push({url:finalUrl,reason:error.message});return null;
    }
    if (!page.text.trim()) { this.failures.push({ url, reason: page.why || 'no-body' }); return null; }
    const doc = page.content_document;
    if (!doc || doc.policy !== DOCUMENT_POLICY) throw new RetrievalInfrastructureError('page-dater', 'wrong_content_policy', 'reader is not using the required content policy');
    if (!doc.usable || !doc.complete || !page.text.trim()) {
      this.failures.push({ url, reason: doc.unusable_reason ?? 'incomplete-body' }); return null;
    }
    if (doc.body_sha256 !== sha256(page.text)) throw new RetrievalInfrastructureError('page-dater', 'document_hash_mismatch', 'extracted document hash mismatch');
    let body = page.text, cleaningReceiptId: string | undefined;
    if (this.cleaner && page.source === 'reader') {
      const cleaned = await this.cleaner.clean({ url: finalUrl, title: page.title, body });
      cleaningReceiptId = cleaned.receiptId;
      if (cleaned.status !== 'cleaned') {
        this.failures.push({ url, reason: `reader-cleaning-${cleaned.status}:${cleaned.receiptId}` }); return null;
      }
      body = cleaned.body;
    }
    return this.save({ url: finalUrl, title: page.title, body, bodySha256: sha256(body), acquiredAt,
      publishedDate: page.published_date ?? page.date, temporalBasis: 'live-page', provenanceId,
      ...(cleaningReceiptId ? { cleaningReceiptId } : {}) });
  }
}
