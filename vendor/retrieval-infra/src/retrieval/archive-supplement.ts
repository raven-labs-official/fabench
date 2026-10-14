/** Small verified capture pools supplement a news corpus without changing its bytes.
 * Exact FRED/ALFRED series ids retain entity identity when a query also names a future month.
 * This is an explicit retrieval component, not an automatic change to formal experiments.
 */
import { createHash } from 'node:crypto';
import { CorpusStore } from '../corpus/store.js';
import { querySnippet } from './snippet.js';
import type { SearchBackend, BackendResult, BackendDoc } from './search-backend.js';
import { VerifiedSeriesCatalog, officialSeriesId, officialObservationSnippet } from './series-catalog.js';

export interface VerifiedArchiveDocument {
  url:string;title:string;body:string;crawlDate:string;source:'cc-main';
  capture_proof:{text_sha256:string;document_sha256:string;warc_record_id:string;cdx_digest:string;[key:string]:unknown};
}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function exactTime(s:string) {
  if(!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s)||!Number.isFinite(Date.parse(s)))throw new Error('exact timezone-qualified anchor required');
  return Date.parse(s);
}

export class ArchiveSupplementBackend implements SearchBackend {
  readonly name='frozen-archive-supplement';
  readonly identity:string;
  private readonly store:CorpusStore;
  private readonly catalog:VerifiedSeriesCatalog;
  private readonly anchor:number;
  private readonly series=new Map<string,Set<string>>();
  private readonly officialUrls=new Set<string>();
  private searches=0;private fetches=0;private seriesRoutes=0;private naturalRoutes=0;
  constructor(documents:readonly VerifiedArchiveDocument[],anchor:string) {
    this.anchor=exactTime(anchor);
    const docs:VerifiedArchiveDocument[]=JSON.parse(JSON.stringify(documents));
    for(const d of docs){
      if(d.source!=='cc-main'||!d.body||d.capture_proof?.text_sha256!==sha(d.body)||
         d.capture_proof.document_sha256!==sha(JSON.stringify([d.url,d.title,d.body,d.crawlDate]))||!d.capture_proof.warc_record_id||!d.capture_proof.cdx_digest)
        throw new Error('verified CC capture proof with matching text hash required');
      if(exactTime(d.crawlDate)>=this.anchor)throw new Error('supplement capture is not before anchor');
      const id=officialSeriesId(d.url);
      if(id){
        const key=id.toLowerCase(),urls=this.series.get(key)??new Set<string>();
        urls.add(d.url);this.series.set(key,urls);this.officialUrls.add(d.url);
      }
    }
    this.identity=sha(JSON.stringify(docs.map(d=>({url:d.url,title:d.title,crawlDate:d.crawlDate,body_sha256:sha(d.body),record:d.capture_proof.warc_record_id})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))));
    this.store=new CorpusStore(':memory:');
    try {this.store.ingest(docs);this.catalog=new VerifiedSeriesCatalog(docs);}catch(error){this.store.close();throw error;}
  }
  private check(asOf:string) {if(exactTime(asOf)!==this.anchor)throw new Error('supplement anchor differs from configured anchor');}
  hasExactSeries(query:string):boolean {
    return (query.toLowerCase().match(/[a-z][a-z0-9]+/g)??[]).some(t=>this.series.has(t));
  }
  hasPreferredSource(query:string):boolean {
    return this.hasExactSeries(query)||this.catalog.search(query,1).length>0;
  }
  async search(query:string,n:number,asOf:string):Promise<BackendResult[]> {
    this.check(asOf);if(!Number.isInteger(n)||n<1)throw new Error('positive result count required');this.searches++;
    const ids=[...new Set((query.toLowerCase().match(/[a-z][a-z0-9]+/g)??[]).filter(t=>this.series.has(t)))];
    if(ids.length)this.seriesRoutes++;
    // An id mentioned in a related-series sidebar does not make that page its source.
    const urls=ids.length?[...new Set(ids.flatMap(id=>[...this.series.get(id)!]))]:this.catalog.search(query,n);
    if(!ids.length&&urls.length)this.naturalRoutes++;
    let hits=urls.flatMap(url=>{const d=this.store.getByUrlBefore(url,asOf);return d?[d]:[];});
    if(ids.length)hits.sort((a,b)=>Date.parse(b.crawlDate)-Date.parse(a.crawlDate)||a.url.localeCompare(b.url));
    // Do not let related-series sidebars bypass the primary-data lookup's guards.
    if(!urls.length)hits=this.store.search(query,asOf,n).filter(h=>!this.officialUrls.has(h.url));
    hits=hits.slice(0,n);
    // Exact official series requests should expose the dated observations even when
    // the query month is newer than the captured page. This only biases extraction;
    // it never invents values or rewrites their dates.
    const snippetQuery = urls.length ? `${query} Observations` : query;
    return hits.map(h=>({title:h.title,url:h.url,
      snippet:(urls.length?officialObservationSnippet(h.body):null)??querySnippet(h.body,snippetQuery,300),
      source:'frozen',crawlDate:h.crawlDate}));
  }
  async fetch(url:string,asOf:string):Promise<BackendDoc|null> {
    this.check(asOf);this.fetches++;const d=this.store.getByUrlBefore(url,asOf);
    return d?{url:d.url,title:d.title,body:d.body.replace(/\s+/g,' '),source:'frozen',crawlDate:d.crawlDate}:null;
  }
  stats(){return {searches:this.searches,fetches:this.fetches,exact_series_routes:this.seriesRoutes,natural_source_routes:this.naturalRoutes};}
  close(){this.catalog.close();this.store.close();}
}
