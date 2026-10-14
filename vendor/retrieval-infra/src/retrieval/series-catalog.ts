import { DatabaseSync } from 'node:sqlite';
import { contentTerms } from '../corpus/store.js';

export const SERIES_CATALOG_POLICY = 'verified-main-and-tags-porter-and-v1';

const calendar = 'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec spring summer autumn winter';
const functional = new Set((calendar + ' forecast forecasts forecasting outlook projected projection projections estimate estimates trend trends current latest today early late level levels').split(' '));
const monthPattern = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
const numeral: Record<string, number> = { one: 1, two: 2, three: 3, five: 5, seven: 7, ten: 10, twenty: 20, thirty: 30 };
const weakTitleTerms = new Set('fred alfred index rate data value source series'.split(' '));

export function officialSeriesId(url: string): string | null {
  const u = new URL(url);
  if (!['fred.stlouisfed.org', 'alfred.stlouisfed.org'].includes(u.hostname)) return null;
  const id = u.pathname.match(/^\/series\/([a-z][a-z0-9]+)\/?$/i)?.[1]
    ?? (u.pathname === '/series' ? u.searchParams.get('seid') : null);
  return id && /^[a-z][a-z0-9]+$/i.test(id) ? id.toUpperCase() : null;
}

/** Show the dated primary observation, not a related-series or methodology match. */
export function officialObservationSnippet(body: string, maxChars=300): string | null {
  const start=body.indexOf(' Observations ');
  if(start<0)return null;
  const ends=['Release Tables','Related Data','Related Categories'].map(m=>body.indexOf(m,start)).filter(n=>n>start);
  if(!ends.length)return null;
  const text=body.slice(start+1,Math.min(...ends)).replace(/\s+/g,' ').trim();
  return '…'+(text.length<=maxChars-1?text:text.slice(0,maxChars-2)+'…');
}

function termsForBackground(query: string): string[] {
  let q = query.replace(/\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, ' ');
  q = q.replace(new RegExp('\\b' + monthPattern + '\\s+\\d{1,2}(?:st|nd|rd|th)?\\b', 'gi'), ' ');
  q = q.replace(/\b(?:19|20)\d{2}\b/g, ' ');
  const terms = contentTerms(q).filter(t => !functional.has(t));
  // The ordinary news tokenizer drops short numbers. Source lookup must retain
  // noncalendar quantities, especially a maturity or an explicitly requested value.
  const numbers = q.match(/\b\d+(?:\.\d+)?\b/g) ?? [];
  return [...new Set([...terms, ...numbers])];
}

function maturities(query: string): string[] {
  const normalized = query.toLowerCase().replace(/[\u2010-\u2015]/g, '-');
  return [...normalized.matchAll(/\b(\d+|one|two|three|five|seven|ten|twenty|thirty)[ -]?(?:year|yr)\b/g)]
    .map(m => String(numeral[m[1]!] ?? Number(m[1])));
}

/** A small source directory, never a relaxed query over the news corpus.
 * Index only original official data text and explicit series tags. Related-series
 * sidebars cannot satisfy a source request. Returned bytes still come from the
 * verified capture store; stemming and intent/date handling affect ranking only.
 */
export class VerifiedSeriesCatalog {
  private readonly db: DatabaseSync;
  private readonly documents: Array<{ url: string; title: string }> = [];

  constructor(documents: readonly { url: string; title: string; body: string; crawlDate: string }[]) {
    this.db = new DatabaseSync(':memory:');
    try {
      this.db.exec("CREATE VIRTUAL TABLE source_main USING fts5(title,body,tokenize='porter unicode61')");
      // Match the fetch store's newest capture / last inserted tie-break policy.
      const latest = new Map<string, (typeof documents)[number]>();
      for (const d of documents) {
        const previous = latest.get(d.url);
        if (!previous || Date.parse(d.crawlDate) >= Date.parse(previous.crawlDate)) latest.set(d.url, d);
      }
      const insert = this.db.prepare('INSERT INTO source_main(rowid,title,body) VALUES(?,?,?)');
      for (const d of latest.values()) {
        if (!officialSeriesId(d.url)) continue;
        const start = d.body.indexOf(' Observations ');
        if (start < 0) continue;
        const ends = ['Release Tables', 'Related Data', 'Related Categories']
          .map(m => d.body.indexOf(m, start)).filter(n => n > start);
        if (!ends.length) continue; // Unknown page templates do not get this route.
        const end = Math.min(...ends), tagStart = d.body.indexOf(' Tags ', end);
        const tagEnd = tagStart < 0 ? -1 : d.body.indexOf(' Permalink/Embed', tagStart);
        const tags = tagStart >= 0 && tagEnd > tagStart ? d.body.slice(tagStart, tagEnd) : '';
        this.documents.push({ url: d.url, title: d.title });
        insert.run(this.documents.length, d.title, d.body.slice(start, end) + ' ' + tags);
      }
    } catch (error) { this.db.close(); throw error; }
  }

  search(query: string, n: number): string[] {
    const tokens = termsForBackground(query);
    if (tokens.length > 32 || tokens.filter(t => /[a-z]/i.test(t)).length < 2) return [];
    const titleTerms=tokens.filter(t=>/[a-z]/i.test(t)&&!weakTitleTerms.has(t));
    if(!titleTerms.length)return [];
    const quote=(t:string)=>'"'+t.replaceAll('"','""')+'"';
    const expression='('+tokens.map(quote).join(' AND ')+') AND title : ('+titleTerms.map(quote).join(' OR ')+')';
    const desired = maturities(query);
    // Notes may describe another series used as an input. A Treasury yield query
    // must not be satisfied by an inflation estimate that merely uses yields.
    const qualifiers=[...query.toLowerCase().matchAll(/\b(yields?|breakeven|forward|nominal|real)\b/g)]
      .map(m=>m[1]!.replace(/^yields$/,'yield'));
    const rows = this.db.prepare('SELECT rowid FROM source_main WHERE source_main MATCH ? ORDER BY bm25(source_main,4,1), rowid').all(expression);
    return rows.map(r => this.documents[Number(r.rowid) - 1]!)
      .filter(d => desired.every(v => maturities(d.title).includes(v)))
      .filter(d => qualifiers.every(q => new RegExp('\\b'+q+'s?\\b','i').test(d.title)))
      .slice(0, n).map(d => d.url);
  }

  close() { this.db.close(); }
}
