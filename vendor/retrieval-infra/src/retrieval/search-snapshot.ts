/** A prospective capture freezes observed bytes AND the ranked search response. */
import { createHash } from 'node:crypto';
import { CorpusStore } from '../corpus/store.js';
import { FrozenBackend, type BackendDoc, type BackendResult, type SearchBackend } from './search-backend.js';
import { normalizeSerperResults, type SerperSearchCapture } from './search-providers.js';

export interface SearchSnapshot {
  schema: 'raven.search-snapshot.v1';
  startedAtUtc: string;
  frozenAtUtc: string;
  provider: string;
  searches: { query: string; requested: number; observedAtUtc: string; results: BackendResult[]; providerCapture?: SerperSearchCapture }[];
  pages: { observedAtUtc: string; sha256: string; doc: BackendDoc }[];
  fetchFailures: { url: string; reason: string }[];
}

export const textHash = (value: string) => createHash('sha256').update(value).digest('hex');

export function validateSnapshot(snapshot: SearchSnapshot): void {
  if (snapshot.schema !== 'raven.search-snapshot.v1') throw new Error('unsupported snapshot schema');
  const cutoff = Date.parse(snapshot.frozenAtUtc), start = Date.parse(snapshot.startedAtUtc);
  if (!Number.isFinite(cutoff) || !Number.isFinite(start) || cutoff < start) throw new Error('invalid capture interval');
  for (const record of [...snapshot.searches, ...snapshot.pages]) {
    const observed = Date.parse(record.observedAtUtc);
    if (!Number.isFinite(observed) || observed > cutoff || observed < start) throw new Error('observation outside the frozen capture interval');
  }
  const queries = new Set<string>();
  for (const row of snapshot.searches) {
    const key = JSON.stringify([row.query,row.requested]);
    if (queries.has(key)) throw new Error('duplicate query/width capture; use separate snapshots for repeat measurements');
    if (!Number.isInteger(row.requested) || row.requested < 1) throw new Error('invalid result width');
    if (row.providerCapture) {
      const capture=row.providerCapture;
      if (textHash(JSON.stringify(capture.response))!==capture.responseSha256) throw new Error('snapshot search response hash mismatch');
      if (capture.observedAtUtc!==row.observedAtUtc || capture.request.q!==row.query || capture.request.num!==Math.min(row.requested,10))
        throw new Error('snapshot provider capture does not match search request');
      const expected=normalizeSerperResults(capture.response,row.requested).map(r=>({...r,snippet:r.snippet??''}));
      const supplied=row.results.map(r=>({url:r.url,title:r.title,snippet:r.snippet??'',date:(r as {date?:string}).date}));
      if(JSON.stringify(expected)!==JSON.stringify(supplied)) throw new Error('snapshot normalized results disagree with provider response');
    }
    queries.add(key);
  }
  for (const page of snapshot.pages) {
    if (textHash(page.doc.body) !== page.sha256) throw new Error('snapshot body hash mismatch');
  }
}

/** Exact control: unknown queries fail explicitly. There is no live-network fallback. */
export class RecordedSearchBackend implements SearchBackend {
  readonly name = 'recorded-search';
  private searches = 0;
  private fetches = 0;
  private readonly snapshot: SearchSnapshot;
  constructor(snapshot: SearchSnapshot) { validateSnapshot(snapshot); this.snapshot = structuredClone(snapshot); }
  private checkAnchor(asOf: string) {
    if (asOf !== this.snapshot.frozenAtUtc) throw new Error('recorded replay requires the exact frozenAtUtc anchor');
  }
  async search(query: string, n: number, asOf: string): Promise<BackendResult[]> {
    this.checkAnchor(asOf); this.searches++;
    const row = this.snapshot.searches.find(r => r.query===query && r.requested===n);
    if (!row) throw new Error('query/width not captured in recorded baseline');
    return structuredClone(row.results);
  }
  async fetch(url: string, asOf: string): Promise<BackendDoc | null> {
    this.checkAnchor(asOf); this.fetches++;
    const page = this.snapshot.pages.filter(p => p.doc.url===url).sort((a,b) => Date.parse(b.observedAtUtc)-Date.parse(a.observedAtUtc))[0];
    return page ? structuredClone(page.doc) : null;
  }
  stats() { return { searches: this.searches, fetches: this.fetches }; }
}

/** Arbitrary-query control: index ONLY captured search snippets and available page bytes.
 * Its ranking statistics cannot see the shared corpus's post-cutoff documents.
 * Coverage is limited to this capture pool and must be reported against the live baseline.
 */
export function frozenSnapshotBackend(snapshot: SearchSnapshot): { backend: FrozenBackend; close: () => void } {
  validateSnapshot(snapshot);
  snapshot = structuredClone(snapshot);
  // A capture pool is small enough for full BM25 OR retrieval; no AND truncation is needed.
  const store = new CorpusStore(":memory:", "or");
  const latest = new Map<string, SearchSnapshot['pages'][number]>();
  for (const p of snapshot.pages) {
    const prior = latest.get(p.doc.url);
    if (!prior || Date.parse(prior.observedAtUtc) < Date.parse(p.observedAtUtc)) latest.set(p.doc.url,p);
  }
  const capturedEvidence = new Map<string, {url:string;title:string;body:string;crawlDate:string;source:string}>();
  for (const search of snapshot.searches) for (const hit of search.results) {
    const prior = capturedEvidence.get(hit.url);
    capturedEvidence.set(hit.url, {
      url:hit.url, title:prior?.title ?? hit.title,
      body:(prior?.body ? prior.body + "\n" : "") + hit.title + "\n" + hit.snippet,
      crawlDate: new Date(Math.max(Date.parse(prior?.crawlDate ?? search.observedAtUtc), Date.parse(search.observedAtUtc))).toISOString(),source:"prospective-search-capture",
    });
  }
  for (const [url,page] of latest) {
    const evidence = capturedEvidence.get(url);
    capturedEvidence.set(url, {
      url,title:evidence?.title ?? page.doc.title,
      body:(evidence?.body ? evidence.body + "\n" : "") + page.doc.body,
      crawlDate: new Date(Math.max(Date.parse(evidence?.crawlDate ?? page.observedAtUtc),Date.parse(page.observedAtUtc))).toISOString(),
      source:"prospective-search-capture",
    });
  }
  try { store.ingest(capturedEvidence.values()); }
  catch (error) { store.close(); throw error; }
  class IsolatedSnapshotBackend extends FrozenBackend {
    private snapshotFetches = 0;
    private guard(asOf: string) {
      if (asOf !== snapshot.frozenAtUtc) throw new Error("snapshot index requires its exact freeze anchor; create another snapshot for another date");
    }
    override async search(query: string, n: number, asOf: string) { this.guard(asOf); return super.search(query,n,asOf); }
    override async fetch(url: string, asOf: string) {
      this.guard(asOf);
      this.snapshotFetches++;
      // Snippets are search evidence, not a substitute for a failed full-page fetch.
      const page = latest.get(url);
      return page ? { ...structuredClone(page.doc), source:"frozen" as const, crawlDate:page.observedAtUtc } : null;
    }
    override stats() { return { ...super.stats(), fetches: this.snapshotFetches }; }
  }
  return { backend: new IsolatedSnapshotBackend(store), close: () => store.close() };
}
