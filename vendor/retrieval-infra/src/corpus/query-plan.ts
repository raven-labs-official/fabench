/** Bounded lexical candidate generation shared by engines; never an answer generator. */
import { queryIdentity } from './query-identity.js';
import { createHash } from 'node:crypto';
export const CONCEPT_QUERY_POLICY = 'concept-routes-period-proximity-v3';
export interface QueryAliases { variants: string[]; provenance: string }
export interface QueryPlanOptions { aliases?: QueryAliases[]; candidateBudget?: number }
export interface QueryConcept { text: string; variants: string[]; frequency: number; required: boolean }
export interface QueryPlan { policy: string; concepts: QueryConcept[]; expressions: string[]; perRoute: number; aliasSources: string[]; focus?: string }

export function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
const STOP = new Set('the a an of to in on for and or is are will would by before after with at as be this that from was were has have had what when where how why which can could should please find search about news article articles'.split(' '));
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const expression = (c: QueryConcept) => `(${c.variants.map(quote).join(' OR ')})`;

export function planQuery(query: string, frequency: (term: string) => number, options: QueryPlanOptions = {}): QueryPlan {
  const budget = options.candidateBudget ?? 180;
  if (!Number.isSafeInteger(budget) || budget < 12 || budget > 600) throw new Error('candidateBudget must be 12–600');
  let remaining = query;
  const raw: { text: string; variants: string[]; required?: boolean }[] = [];
  const aliasSources: string[] = [];
  remaining = remaining.replace(/"([^"\n]+)"/g, (_, phrase: string) => {
    const text = fold(phrase); if (text) raw.push({ text, variants: [text], required: true }); return ' ';
  });
  // Explicit aliases are versioned input. No hidden current-world entity expansion.
  for (const group of options.aliases ?? []) {
    if (!group.provenance.trim() || group.variants.length < 2 || group.variants.length > 12) throw new Error('aliases require 2–12 variants and provenance');
    const variants = [...new Set(group.variants.map(fold).filter(Boolean))];
    const normalized = ` ${fold(remaining)} `;
    const hit = variants.find(v => normalized.includes(` ${v} `));
    if (hit) {
      raw.push({ text: hit, variants }); aliasSources.push(group.provenance);
      // Normalization here also handles punctuation in acronyms and multiword phrases.
      remaining = normalized.replace(` ${hit} `, ' ');
    }
  }
  // Period syntax is one compositional rule, alongside general phrase/alias/morphology routes.
  remaining = remaining.replace(/\b(?:fy\s*|fiscal(?:\s+year)?\s+)(20\d\d)\b/gi, (_, year: string) => {
    raw.push({ text: `fiscal year ${year}`, variants: [`fy${year}`, `fy ${year}`, `fiscal ${year}`, `fiscal year ${year}`] }); return ' ';
  });
  const tokens = [...new Set(fold(remaining).split(' ').filter(t => t.length > 1 && !STOP.has(t)))];
  for (const text of tokens) {
    const variants = [text];
    // Conservative spelling alternatives, not hard semantic equivalence.
    if (/^[a-z]{5,}ies$/.test(text)) variants.push(text.slice(0, -3) + 'y');
    else if (/^[a-z]{4,}s$/.test(text) && !/(ss|us|is)$/.test(text)) variants.push(text.slice(0, -1));
    raw.push({ text, variants });
  }
  if (raw.length > 24) throw new Error('query contains more than 24 concepts; use a more focused query');
  // Alias group order is model output, not query intent. Preserve the original
  // phrase order when choosing the focus and resolving frequency ties.
  const original = ` ${fold(query)} `;
  const position = (c:typeof raw[number]) => Math.min(...c.variants.map(v => original.indexOf(` ${v} `)).filter(n => n >= 0), Infinity);
  raw.sort((a,b) => position(a)-position(b));
  const concepts = raw.map(c => {
    const counts = c.variants.map(v => {
      const terms = v.split(' ').map(frequency);
      return terms.every(n => n > 0) ? Math.min(...terms) : 0;
    }).filter(n => n > 0);
    return { ...c, frequency: counts.length ? Math.min(...counts) : 0, required: c.required === true || counts.length === 0 };
  });
  if (!concepts.length) return { policy: CONCEPT_QUERY_POLICY, concepts, expressions: [], perRoute: 0, aliasSources };
  // An absent literal/phrase remains mandatory: dropping an unknown identifier is not recall.
  if (concepts.some(c => c.required && c.frequency === 0)) return { policy: CONCEPT_QUERY_POLICY, concepts, expressions: [], perRoute: 0, aliasSources };
  const rare = [...concepts].sort((a, b) => a.frequency - b.frequency);
  // Keep the query's first non-period content term as a second branch anchor. This avoids
  // every reformulation collapsing to the same globally rare pair.
  const first = concepts.find(c => !/^(?:\d|fiscal year)/.test(c.text));
  const anchors = [...new Set([rare[0]!, first].filter((c): c is QueryConcept => Boolean(c)))];
  const required = concepts.filter(c => c.required);
  const identityConstraints = queryIdentity(query).constraints.map(constraint => {
    const literal = /^"([^"]+)"$/.exec(constraint)?.[1];
    const alias = literal ? concepts.find(c => c.variants.includes(fold(literal))) : undefined;
    return alias ? expression(alias) : constraint;
  });
  const routes = new Set<string>();
  const add = (parts: string[]) => routes.add([...new Set([...identityConstraints, ...parts])].sort().join(' AND '));
  add(concepts.map(expression));
  for (const anchor of anchors) {
    const others = concepts.filter(c => c !== anchor);
    if (others.length) add([...required.map(expression), expression(anchor), `(${others.map(expression).join(' OR ')})`]);
    for (const other of rare.filter(c => c !== anchor).slice(0, 2)) add([...required.map(expression), expression(anchor), expression(other)]);
  }
  const expressions = [...routes].slice(0, 6);
  return { policy: CONCEPT_QUERY_POLICY, concepts, expressions, perRoute: Math.floor(budget / expressions.length), aliasSources, focus: first?.text };
}

export interface RankedDocument { url: string; title: string; body: string; crawlDate: string; score: number }
function contains(text: string, phrase: string) {
  // Equivalent literal-space boundaries without copying a whole long article
  // into a newly padded string for every concept and spelling variant.
  let at = text.indexOf(phrase);
  while (at >= 0) {
    const end = at + phrase.length;
    if ((at === 0 || text.charCodeAt(at - 1) === 32) &&
        (end === text.length || text.charCodeAt(end) === 32)) return true;
    if (at === text.length) break; // Empty phrases must still terminate.
    at = text.indexOf(phrase, at + 1);
  }
  return false;
}
interface PreparedDocument {
  doc: RankedDocument; title: string; body: string; words: string[];
  lead?: string; passages?: string[];
  numbers?: string; shingles?: Set<string>;
}
function prepareDocument(doc: RankedDocument): PreparedDocument {
  const body = fold(doc.body);
  return { doc, title: fold(doc.title), body, words: body.split(' ') };
}

/** Only content-derived features persist, keyed by the exact title/body bytes.
 * Each query retains fresh source verification and its own ranking/dedup state.
 */
export class RankFeatureCache {
  private entries=new Map<string,{features:Omit<PreparedDocument,'doc'|'numbers'|'shingles'>;bytes:number}>();
  private bytes=0;private hits=0;private misses=0;
  constructor(private readonly maxBytes=32*1024*1024) {
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('Invalid rank feature cache budget');
  }
  prepare(doc:RankedDocument):PreparedDocument {
    const key=createHash('sha256').update(String(Buffer.byteLength(doc.title))).update(':').update(doc.title).update(doc.body).digest('hex');
    const saved=this.entries.get(key);
    if(saved) {this.hits++;this.entries.delete(key);this.entries.set(key,saved);return {doc,...saved.features};}
    this.misses++;
    const prepared=prepareDocument(doc),{title,body,words}=prepared;
    const lead=words.slice(0,250).join(' '),passages:string[]=[];
    for(let start=0;start<words.length;start+=100)passages.push(words.slice(start,start+200).join(' '));
    const features={title,body,words,lead,passages};
    // Conservative retained-size accounting, plus a count cap for very short pages.
    const bytes=8*(title.length+body.length+lead.length+passages.reduce((n,s)=>n+s.length,0))+48*words.length+256;
    if(bytes<=this.maxBytes) {
      while(this.entries.size && (this.bytes+bytes>this.maxBytes || this.entries.size>=512)) {
        const oldest=this.entries.keys().next().value!;this.bytes-=this.entries.get(oldest)!.bytes;this.entries.delete(oldest);
      }
      this.entries.set(key,{features,bytes});this.bytes+=bytes;
    }
    return {doc,...features};
  }
  snapshot(){return {hits:this.hits,misses:this.misses,entries:this.entries.size,accountedBytes:this.bytes,maxBytes:this.maxBytes};}
}
export function relevance(doc: RankedDocument, plan: QueryPlan): number {
  return preparedRelevance(prepareDocument(doc), plan);
}
function preparedRelevance(prepared: PreparedDocument, plan: QueryPlan): number {
  const {title, body, words} = prepared;
  const maxFrequency = Math.max(1, ...plan.concepts.map(c => c.frequency));
  let value = 0;
  for (const c of plan.concepts) {
    const weight = 1 + Math.min(4, Math.log1p(maxFrequency / Math.max(1, c.frequency)));
    if (c.variants.some(v => contains(body, v))) value += weight;
    if (c.variants.some(v => contains(title, v))) value += 1.5 * weight;
  }
  const focus = plan.concepts.find(c => c.text === plan.focus);
  if (focus) {
    if (focus.variants.some(v => contains(title, v))) value += 10;
    // A literal appearing only at the end of an old flattened page is weak entity evidence.
    const lead = prepared.lead ?? words.slice(0, 250).join(' ');
    if (!focus.variants.some(v => contains(title, v) || contains(lead, v))) value -= 10;
  }
  // Reward joint support within a passage, not words scattered through navigation.
  let passage = 0;
  for (let start = 0; start < words.length; start += 100) {
    const text = prepared.passages?.[start/100] ?? words.slice(start, start + 200).join(' ');
    passage = Math.max(passage, plan.concepts.filter(c => c.variants.some(v => contains(text, v))).length);
  }
  value += passage * 0.6;
  // A queried period should occur next to the other requested concepts, not only
  // in a distant navigation item or generic discussion of the following year.
  const periods=plan.concepts.filter(c=>/\b(?:19|20)\d{2}\b/.test(c.text)||/^fy\d{4}$/.test(c.text));
  const details=plan.concepts.filter(c=>c!==focus&&!periods.includes(c));
  if(periods.length&&details.length){
    let best=0;
    const phrases=periods.flatMap(c=>c.variants);
    // A seven-word window can contain a period phrase only if it contains that
    // phrase's first token. Find those centers cheaply, then apply the original
    // exact phrase test and scoring below. Keep the full scan for noncanonical
    // caller-supplied phrases so the exported function preserves their behavior.
    const canonical=phrases.every(v=>v.length>0&&v===fold(v));
    const centers=new Set<number>();
    if(canonical){
      const firstTokens=new Set(phrases.map(v=>v.split(' ')[0]!));
      for(let at=0;at<words.length;at++)if(firstTokens.has(words[at]!))
        for(let i=Math.max(0,at-3);i<=Math.min(words.length-1,at+3);i++)centers.add(i);
    }else for(let i=0;i<words.length;i++)centers.add(i);
    for(const i of [...centers].sort((a,b)=>a-b)){
      if(!periods.some(c=>c.variants.some(v=>contains(words.slice(Math.max(0,i-3),i+4).join(' '),v))))continue;
      const nearby=words.slice(Math.max(0,i-24),i+25).join(' ');
      const matches=details.filter(c=>c.variants.some(v=>contains(nearby,v))).length;
      best=Math.max(best,matches/details.length);
    }
    value+=12*best;
  }
  // A bounded completeness tie-breaker; raw page length must not dominate relevance.
  value += Math.min(0.8, Math.log1p(body.length / 200) / 5);
  return value;
}
function shingles(text: string): Set<string> {
  const words = fold(text).split(' '); const out = new Set<string>();
  for (let i = 0; i + 4 < words.length; i++) out.add(words.slice(i, i + 5).join(' '));
  return out;
}
export function sameContent(a: RankedDocument, b: RankedDocument): boolean {
  return samePreparedContent(prepareDocument(a), prepareDocument(b));
}
/** Text used by the content comparison; the document objects must not change afterwards. */
type ContentDocument = Pick<RankedDocument, 'title' | 'body'>;
const preparedContent = new WeakMap<ContentDocument, PreparedDocument>();
/**
 * Same answer as `sameContent`, but each document object is folded once and its numbers and
 * shingles are kept for later comparisons. Candidate scheduling compares every ready page
 * with every accepted one, and refolding both full texts each time was a large share of the
 * main thread.
 */
export function sameDocumentContent(a: ContentDocument, b: ContentDocument): boolean {
  const prepared = (doc: ContentDocument) => {
    let entry = preparedContent.get(doc);
    if (!entry) { entry = prepareDocument(doc as RankedDocument); preparedContent.set(doc, entry); }
    return entry;
  };
  return samePreparedContent(prepared(a), prepared(b));
}
function samePreparedContent(a: PreparedDocument, b: PreparedDocument): boolean {
  const aa = a.body, bb = b.body;
  if (!aa || !bb) return false;
  if (aa === bb) return true;
  // Preserve differing numerical facts/periods, even if most surrounding prose is identical.
  const numbers = (s: string) => [...new Set(s.match(/\d+(?:[.,]\d+)*/g) ?? [])].sort().join('|');
  if ((a.numbers ??= numbers(a.doc.body)) !== (b.numbers ??= numbers(b.doc.body))) return false;
  const sa = a.shingles ??= shingles(aa), sb = b.shingles ??= shingles(bb);
  if (Math.min(sa.size, sb.size) < 12) return false;
  let common = 0; for (const s of sa) if (sb.has(s)) common++;
  return common / Math.min(sa.size, sb.size) >= 0.92;
}
export function rankAndDeduplicate(rows: RankedDocument[], plan: QueryPlan, limit: number, features?:RankFeatureCache): RankedDocument[] {
  const latest = new Map<string, RankedDocument>();
  for (const row of rows) {
    const prior = latest.get(row.url);
    if (!prior || row.crawlDate > prior.crawlDate || (row.crawlDate === prior.crawlDate && row.body.length > prior.body.length)) latest.set(row.url, row);
  }
  // Rank scores and deduplication stay query-local. Optional features are reused
  // only after their exact content key matches these newly verified documents.
  const ranked = [...latest.values()].map(doc => {
    const prepared = features?.prepare(doc) ?? prepareDocument(doc);
    return {doc: {...doc, score: -preparedRelevance(prepared, plan)}, prepared};
  }).sort((a, b) => a.doc.score - b.doc.score || a.doc.url.localeCompare(b.doc.url));
  const out: typeof ranked = [];
  for (const entry of ranked) {
    if (!out.some(prior => sameArticleEdition(prior.doc, entry.doc) || samePreparedContent(prior.prepared, entry.prepared))) out.push(entry);
    if (out.length === limit) break;
  }
  return out.map(entry => entry.doc);
}

/** Only layout editions of the same URL/title; unrelated syndicated articles stay separate. */
export function sameArticleEdition(a:RankedDocument,b:RankedDocument):boolean{
  if(fold(a.title)!==fold(b.title))return false;
  const edition=(url:string)=>{
    const u=new URL(url);u.hostname=u.hostname.replace(/^(?:www\.|m\.|mobile\.)/,'');
    u.pathname=u.pathname.replace(/^\/amp\//,'/').replace(/\/amp\/?$/,'/');
    for(const key of ['amp','ampMode','output','utm_source','utm_medium','utm_campaign']){
      if(key!=='output'||u.searchParams.get(key)==='amp')u.searchParams.delete(key);
    }
    return u.toString();
  };
  try{return edition(a.url)===edition(b.url);}catch{return false;}
}
