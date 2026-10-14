import type { EvidenceDocument } from './document-reader.js';

export type EvidenceField = 'title' | 'body' | 'url' | 'publishedDate' | 'availableAt';
export interface VisibleField { field: EvidenceField; text: string; start: number; }
export type VisibleEvidence = Map<string, VisibleField[] | string[]>;
export interface QuoteLocation { field: EvidenceField | 'candidate'; start: number; end: number; text: string; }
export interface EvidenceCitation {
  sourceId: string; candidateQuote: string; sourceQuote: string;
  sourceField?: EvidenceField;
  relation: 'pre_anchor_support' | 'post_anchor_release' | 'post_anchor_event';
  timeQuote?: string; time?: string; timeField?: EvidenceField;
  timeContextQuote?: string; timeContextField?: EvidenceField; timeExplanation?: string;
  timeRangeUtc?: { earliest: string; latest: string };
  locations?: { candidate: QuoteLocation; source: QuoteLocation; time?: QuoteLocation; timeContext?: QuoteLocation };
}
export class EvidenceValidationError extends Error {
  constructor(readonly code: string, message: string, readonly citationIndex?: number, readonly blockId?: string) {
    super(message); this.name = 'EvidenceValidationError';
  }
}

/** Match whitespace changes only. Preserve punctuation, numbers, ordering and original offsets. */
function normalize(text: string) {
  const starts: number[] = [], ends: number[] = []; let value = '';
  for (let i = 0; i < text.length;) {
    const begin = i;
    if (/\s/u.test(text[i]!)) {
      while (i < text.length && /\s/u.test(text[i]!)) i++;
      value += ' '; starts.push(begin); ends.push(i);
    } else { value += text[i]!; starts.push(i); ends.push(++i); }
  }
  return { value, starts, ends };
}
function locate(quote: string, view: VisibleField | { field: 'candidate'; text: string; start: number }): QuoteLocation | null {
  if (typeof quote !== 'string' || !quote.trim()) return null;
  const hay = normalize(view.text), needle = normalize(quote).value.trim();
  const i = hay.value.indexOf(needle); if (i < 0) return null;
  const start = hay.starts[i]!, end = hay.ends[i + needle.length - 1]!;
  return { field: view.field, start: view.start + start, end: view.start + end, text: view.text.slice(start, end) };
}
function fields(views: VisibleField[] | string[]): VisibleField[] {
  // Compatibility for offline callers that registered body excerpts under v1.
  return views.map(v => typeof v === 'string' ? { field: 'body', text: v, start: 0 } : v);
}
function sourceLocation(quote: string, field: EvidenceField | undefined, views: VisibleField[], label: string, index: number): QuoteLocation {
  const matches = views.filter(v => field == null || field === v.field).flatMap(v => { const m = locate(quote, v); return m ? [m] : []; });
  if (!matches.length) throw new EvidenceValidationError('unread_quote', `${label} citation was not read in the requested field; quote one continuous visible span`, index);
  if (new Set(matches.map(m => m.field)).size > 1) throw new EvidenceValidationError('ambiguous_field', `${label} quote matches several fields; specify its field`, index);
  return matches[0]!;
}
export function registerVisibleSource(visible: VisibleEvidence, source: EvidenceDocument, start: number, part: string): void {
  const next: VisibleField[] = [{ field: 'body', text: part, start }, { field: 'title', text: source.title, start: 0 },
    { field: 'url', text: source.url, start: 0 }];
  if (source.publishedDate) next.push({ field: 'publishedDate', text: source.publishedDate, start: 0 });
  if (source.availableAt) next.push({ field: 'availableAt', text: source.availableAt, start: 0 });
  visible.set(source.id, [...fields(visible.get(source.id) ?? []), ...next]);
}

const DAY = 86_400_000;
function day(y: number, m: number, d: number): number | null {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d), t = new Date(ms);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? ms : null;
}
/** Intervals are inclusive; never invent midnight from an imprecise date. */
export function timeRange(value: string): [number, number] | null {
  if (typeof value !== 'string') return null;
  const coarse = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (coarse) {
    const y = +coarse[1]!, m = +(coarse[2] ?? 1), d = +(coarse[3] ?? 1), lo = day(y, m, d);
    if (lo == null) return null;
    const hi = coarse[3] ? lo + DAY : coarse[2] ? Date.UTC(y, m, 1) : Date.UTC(y + 1, 0, 1);
    return [lo, hi - 1];
  }
  const exact = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!exact || day(+exact[1]!, +exact[2]!, +exact[3]!) == null || +exact[4]! > 23 || +exact[5]! > 59 || +(exact[6] ?? 0) > 59) return null;
  const ms = Date.parse(value);
  const precisionMs = exact[7] ? 10 ** (3 - exact[7].length) : exact[6] ? 1000 : 60_000;
  return Number.isFinite(ms) ? [ms, ms + precisionMs - 1] : null;
}
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
function iso(y: number, m: number, d: number): string { return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
function namedDateTime(month: string, date: string, year: string, hour: string, minute: string,
  second: string | undefined, meridiem: string | undefined, timezone: string): [number, number] | null {
  let h=+hour;const ampm=meridiem?.toUpperCase();if(ampm && (h<1 || h>12))return null;
  if(ampm)h=h%12+(ampm==='PM'?12:0);
  const zones:Record<string,string>={UTC:'Z',GMT:'Z',EST:'-05:00',EDT:'-04:00',PST:'-08:00',PDT:'-07:00'};
  const zone=zones[timezone.toUpperCase()] ?? timezone.replace(/^([+-]\d{2})(\d{2})$/,'$1:$2');
  const day=iso(+year,MONTHS.indexOf(month.slice(0,3).toLowerCase())+1,+date);
  return timeRange(`${day}T${String(h).padStart(2,'0')}:${minute}${second?':'+second:''}${zone}`);
}
export function dateEvidenceRange(quote: string, claimed: string): [number, number] | null {
  const expected = timeRange(claimed); if (!expected) return null;
  const ranges: [number, number][] = []; let rest = quote;
  function take(re: RegExp, parse: (m: RegExpExecArray) => [number, number] | null) {
    rest = rest.replace(re, (...args: unknown[]) => {
      const match = args.slice(0, -2) as unknown as RegExpExecArray;
      const range = parse(match); if (range) ranges.push(range);
      // Remove invalid/ambiguous full dates too: never salvage a year from February 30.
      return ' '.repeat(String(args[0]).length);
    });
  }
  take(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/g, m => timeRange(m[0]));
  take(new RegExp(`\\b(${MONTH})\\s+(\\d{1,2}),?\\s+(\\d{4})(?:,?\\s+|\\s+at\\s+)(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(AM|PM)?\\s*(UTC|GMT|EST|EDT|PST|PDT|[+-]\\d{2}:?\\d{2})\\b`,'gi'), m => {
    return namedDateTime(m[1]!,m[2]!,m[3]!,m[4]!,m[5]!,m[6],m[7],m[8]!);
  });
  take(new RegExp(`\\b(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(AM|PM)?\\s*(UTC|GMT|EST|EDT|PST|PDT|[+-]\\d{2}:?\\d{2}),?\\s+(${MONTH})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`,'gi'),
    m => namedDateTime(m[6]!,m[7]!,m[8]!,m[1]!,m[2]!,m[3],m[4],m[5]!));
  take(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g, m => timeRange(iso(+m[1]!, +m[2]!, +m[3]!)));
  take(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, m => {
    const a = +m[1]!, b = +m[2]!, y = +m[3]!;
    if (a <= 12 && b > 12) return timeRange(iso(y,a,b));
    if (b <= 12 && a > 12) return timeRange(iso(y,b,a));
    if (a === b) return timeRange(iso(y,a,b));
    return null;
  });
  take(new RegExp(`\\b(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,'gi'), m => timeRange(iso(+m[3]!, MONTHS.indexOf(m[1]!.slice(0,3).toLowerCase())+1,+m[2]!)));
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+(${MONTH})[\\s-]+(\\d{4})\\b`,'gi'), m => timeRange(iso(+m[3]!, MONTHS.indexOf(m[2]!.slice(0,3).toLowerCase())+1,+m[1]!)));
  take(new RegExp(`\\b(${MONTH})\\s+(\\d{4})\\b`,'gi'), m => timeRange(`${m[2]}-${String(MONTHS.indexOf(m[1]!.slice(0,3).toLowerCase())+1).padStart(2,'0')}`));
  take(/\b\d{4}-\d{2}\b/g, m => timeRange(m[0]));
  // Bare years can describe fiscal periods or quantities. Require an explicit calendar date/month.
  const matching=ranges.filter(found => (found[0] >= expected[0] && found[1] <= expected[1]) ||
    // Accept canonical :00 for a minute timestamp, while retaining the FULL minute interval.
    (found[1]-found[0]<60_000 && found[0]===expected[0]));
  // A bare calendar date has no source timezone. Bound civil offsets UTC-12 through UTC+14;
  // only explicit zoned timestamps avoid this margin. This matters close to the anchor.
  const bounded=matching.map(([lo,hi])=>hi-lo>=DAY-1 ? [lo-14*3_600_000,hi+12*3_600_000] : [lo,hi]);
  return bounded.length ? [Math.min(...bounded.map(r=>r[0]!)),Math.max(...bounded.map(r=>r[1]!))] : null;
}
export function dateAppears(quote: string, claimed: string): boolean { return dateEvidenceRange(quote,claimed)!==null; }

export function parseEvidenceVerdict(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const blocks=[...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const soleFence=blocks.length===1 && !/[{}\[\]]/.test(trimmed.replace(blocks[0]![0],'')) ? blocks[0]![1] : undefined;
  try { return JSON.parse(fenced ? fenced[1]! : soleFence ?? trimmed); }
  catch { throw new EvidenceValidationError('invalid_json', 'Return one JSON object only; no explanatory prose before or after JSON'); }
}

/** Structural provenance/date checks. Semantic linkage and complete fact coverage remain model judgments. */
export function validateEvidence(raw: unknown, candidate: string, anchor: string,
  sources: Map<string, EvidenceDocument>, visible: VisibleEvidence, candidateOffset = 0): { status: 'supported' | 'leaked' | 'unknown'; reason: string; evidence: EvidenceCitation[] } {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(anchor) || !timeRange(anchor)) throw new EvidenceValidationError('invalid_anchor', 'anchor must be an exact ISO time with timezone');
  const value = raw as Record<string, unknown> | null;
  if (!value || !['supported','leaked','unknown'].includes(String(value.status)) || typeof value.reason !== 'string')
    throw new EvidenceValidationError('invalid_verdict', 'invalid evidence verdict');
  if (value.status === 'unknown') return { status: 'unknown', reason: value.reason.slice(0,1000), evidence: [] };
  if (!Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 100) throw new EvidenceValidationError('missing_citations','verdict requires citations');
  const checked: EvidenceCitation[] = [];
  for (const [index, entry] of value.evidence.entries()) {
    const c = entry as EvidenceCitation;
    if (!c || typeof c.sourceId !== 'string') throw new EvidenceValidationError('invalid_citation','invalid citation',index);
    const candidateLocation = locate(c.candidateQuote, { field:'candidate', text:candidate, start:candidateOffset });
    if (!candidateLocation) throw new EvidenceValidationError('candidate_quote','invalid candidate citation; quote a continuous span of the current passage',index);
    const source = sources.get(c.sourceId), views = fields(visible.get(c.sourceId) ?? []);
    if (!source) throw new EvidenceValidationError('unread_source','citation was not read: sourceId must come from read_source',index);
    const fact = sourceLocation(c.sourceQuote, c.sourceField, views,'source',index);
    if (!['title','body'].includes(fact.field)) throw new EvidenceValidationError('metadata_fact','URL/date metadata is not a factual source passage',index);
    if (!['pre_anchor_support','post_anchor_release','post_anchor_event'].includes(c.relation)) throw new EvidenceValidationError('invalid_relation','invalid temporal relation',index);
    const locations: NonNullable<EvidenceCitation['locations']> = { candidate:candidateLocation, source:fact };
    let timeRangeUtc: EvidenceCitation['timeRangeUtc'];
    const historical = source.temporalBasis === 'wikipedia-revision' && source.availableAt && Date.parse(source.availableAt) < Date.parse(anchor);
    if (!(c.relation === 'pre_anchor_support' && historical)) {
      if (typeof c.time !== 'string' || typeof c.timeQuote !== 'string' || !c.timeQuote.trim()) throw new EvidenceValidationError('missing_time','missing explicit time evidence',index);
      const date = sourceLocation(c.timeQuote, c.timeField, views,'time',index);
      if (!['title','body'].includes(date.field)) throw new EvidenceValidationError('metadata_time','Publication metadata alone cannot date current content; read a dated statement about the same fact',index);
      const range=dateEvidenceRange(date.text,c.time);
      if (!range) throw new EvidenceValidationError('time_format','missing explicit time evidence: unsupported, ambiguous or over-precise date; use the precision actually visible',index);
      const inline = date.field === fact.field && date.start >= fact.start && date.end <= fact.end;
      if (!inline || c.timeContextQuote != null) {
        if (typeof c.timeContextQuote !== 'string' || typeof c.timeExplanation !== 'string' || !c.timeExplanation.trim() || c.timeExplanation.length > 1500)
          throw new EvidenceValidationError('time_link','Separate date evidence requires timeContextQuote and timeExplanation linking the same fact to its issue/event date',index);
        const link = sourceLocation(c.timeContextQuote,c.timeContextField,views,'time context',index);
        if (!['title','body'].includes(link.field)) throw new EvidenceValidationError('metadata_link','Time linkage must quote article text, not metadata',index);
        locations.timeContext = link;
      }
      if (c.relation === 'pre_anchor_support' ? range[1] >= Date.parse(anchor) : range[0] < Date.parse(anchor))
        throw new EvidenceValidationError('anchor_side','time evidence is on the wrong side of the anchor or unresolved within the day',index);
      locations.time = date;
      timeRangeUtc={earliest:new Date(range[0]).toISOString(),latest:new Date(range[1]).toISOString()};
    }
    checked.push({ sourceId:c.sourceId, candidateQuote:c.candidateQuote, sourceQuote:c.sourceQuote, sourceField:fact.field as EvidenceField,
      relation:c.relation, ...(timeRangeUtc ? {time:c.time, timeQuote:c.timeQuote, timeField:locations.time!.field as EvidenceField,
        timeContextQuote:c.timeContextQuote, timeContextField:locations.timeContext?.field as EvidenceField | undefined,
        timeExplanation:c.timeExplanation, timeRangeUtc} : {}), locations });
  }
  if (value.status === 'supported' && checked.some(c => c.relation !== 'pre_anchor_support')) throw new EvidenceValidationError('contradiction','contradictory support');
  if (value.status === 'leaked' && !checked.some(c => c.relation !== 'pre_anchor_support')) throw new EvidenceValidationError('missing_future_evidence','leak verdict has no future evidence');
  return { status:value.status as 'supported' | 'leaked', reason:value.reason.slice(0,1000), evidence:checked };
}
