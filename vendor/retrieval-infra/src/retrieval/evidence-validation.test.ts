import test from 'node:test';
import assert from 'node:assert/strict';
import { dateAppears, dateEvidenceRange, timeRange, validateEvidence, registerVisibleSource, parseEvidenceVerdict } from './evidence-validation.js';
import type { VisibleEvidence } from './evidence-validation.js';
import type { EvidenceDocument } from './document-reader.js';

const anchor='2026-03-01T00:00:00Z', claim='The agency issued a forecast of 42 units.';
const title='Agency announces 42-unit forecast';
const body=`January 28, 2026\n\nThe agency today issued its annual forecast.\n\n${claim}\n\nA different statement that was never read.`;
const source={id:'s',title,body,url:'https://synthetic.example/news',publishedDate:'2026-01-28',temporalBasis:'live-page'} as EvidenceDocument;
function setup() { const visible:VisibleEvidence=new Map(); registerVisibleSource(visible,source,0,body.slice(0,body.indexOf('A different')));return {visible,sources:new Map([['s',source]])}; }
const citation={sourceId:'s',candidateQuote:claim,sourceQuote:claim,sourceField:'body' as const,relation:'pre_anchor_support' as const,
  time:'2026-01-28',timeQuote:'January 28, 2026',timeField:'body' as const,
  timeContextQuote:'The agency today issued its annual forecast.',timeContextField:'body' as const,
  timeExplanation:'The dateline belongs to the forecast announcement, whose text identifies today as its issue date.'};
function check(c:any=citation,candidate=claim,status='supported') {const {visible,sources}=setup();return validateEvidence({status,reason:'synthetic',evidence:[c]},candidate,anchor,sources,visible,100);}

test('read title is citable and separate dateline is anchored to visible text',()=>{
  const v=check({...citation,sourceQuote:title,sourceField:'title'});
  assert.equal(v.status,'supported');assert.equal(v.evidence[0]!.locations!.source.field,'title');
  assert.equal(v.evidence[0]!.locations!.time!.text,'January 28, 2026');
  assert.equal(v.evidence[0]!.locations!.candidate.start,100);
  assert.equal(check().evidence[0]!.locations!.source.start,body.indexOf(claim));
});
test('unread body, URL facts, metadata-only dates and missing linkage remain rejected',()=>{
  assert.throws(()=>check({...citation,sourceQuote:'A different statement that was never read.'}),/not read/);
  assert.throws(()=>check({...citation,sourceQuote:source.url,sourceField:'url'}),/not a factual/);
  assert.throws(()=>check({...citation,timeQuote:'2026-01-28',timeField:'publishedDate'}),/metadata alone/);
  assert.throws(()=>check({...citation,timeContextQuote:undefined}),/Separate date/);
  assert.throws(()=>check({...citation,timeContextQuote:'I made up this link'}),/not read/);
});
test('whitespace matching retains original offsets but disjoint quotes and changed quantities fail',()=>{
  const spaced=claim.replace('agency issued','agency\n\tissued');
  const v=check({...citation,candidateQuote:spaced,sourceQuote:spaced});
  assert.equal(v.evidence[0]!.locations!.source.text,claim);
  assert.throws(()=>check({...citation,sourceQuote:'The agency issued ... 42 units.'}),/not read/);
  assert.throws(()=>check({...citation,sourceQuote:claim.replace('42','43')}),/not read/);
});
test('pagination registers only shown slices and preserves absolute body offsets',()=>{
  const visible:VisibleEvidence=new Map();registerVisibleSource(visible,source,body.indexOf(claim),claim);
  const values=new Map([['s',source]]);
  assert.throws(()=>validateEvidence({status:'supported',reason:'ok',evidence:[citation]},claim,anchor,values,visible),/not read/);
  registerVisibleSource(visible,source,0,body.slice(0,body.indexOf(claim)));
  assert.equal(validateEvidence({status:'supported',reason:'ok',evidence:[citation]},claim,anchor,values,visible).evidence[0]!.locations!.source.start,body.indexOf(claim));
});
test('numeric and named dates preserve uncertainty instead of adding precision',()=>{
  for (const s of ['2026/01/28','01/28/2026','28/01/2026','January 28, 2026','Jan. 28, 2026','28 January 2026','2026-01-28']) assert.equal(dateAppears(s,'2026-01-28'),true,s);
  assert.equal(dateAppears('January 2026','2026-01'),true);
  assert.equal(dateAppears('January 2026','2026-01-01'),false);
  assert.equal(dateAppears('01/02/2026','2026-01-02'),false);
  assert.equal(dateAppears('February 30, 2026','2026'),false);
  assert.equal(dateAppears('January 28, 2026','2026-01-28T00:00:00Z'),false);
  assert.equal(dateAppears('2026-01-28T12:30:10+01:00','2026-01-28'),true);
  assert.equal(dateAppears('January 28','2026-01-28'),false);
  assert.equal(dateAppears('Guidance for FY2026','2026'),false);
  assert.equal(timeRange('2026-02-30T12:00:00Z'),null);
  assert.equal(timeRange('2026-01-28T24:00:00Z'),null);
  assert.deepEqual(dateEvidenceRange('January 28, 2026','2026-01-28'),[Date.parse('2026-01-27T10:00:00Z'),Date.parse('2026-01-29T11:59:59.999Z')]);
  assert.deepEqual(dateEvidenceRange('2026-01-28T12:30Z','2026-01-28T12:30:00Z'),[Date.parse('2026-01-28T12:30:00Z'),Date.parse('2026-01-28T12:30:59.999Z')]);
  assert.equal(dateAppears('January 15, 2026 at 5:34 AM UTC','2026-01-15T05:34:00Z'),true);
  assert.equal(dateAppears('Feb 26, 2026 6:22 AM EST','2026-02-26T06:22:00-05:00'),true);
  assert.equal(dateAppears('28-Jan-2026','2026-01-28'),true);
  assert.equal(dateAppears('Sept. 11, 2026','2026-09-11'),true);
});
test('genuine future dates cannot pass as support and uncertain anchor-day evidence is withheld',()=>{
  const {visible,sources}=setup();
  const c={...citation,time:'2026-01-28'};
  assert.throws(()=>validateEvidence({status:'supported',reason:'ok',evidence:[c]},claim,'2026-01-28T12:00:00Z',sources,visible),/wrong side/);
  assert.throws(()=>validateEvidence({status:'supported',reason:'timezone uncertain',evidence:[c]},claim,'2026-01-29T00:00:00Z',sources,visible),/wrong side/);
  assert.equal(validateEvidence({status:'leaked',reason:'later issue',evidence:[{...citation,relation:'post_anchor_release'}]},claim,'2026-01-01T00:00:00Z',sources,visible).status,'leaked');
});
test('clock-first datelines preserve timezone and full displayed minute uncertainty',()=>{
  assert.deepEqual(dateEvidenceRange('Updated 11:47 PM UTC, January 28, 2026','2026-01-28T23:47:00Z'),
    [Date.parse('2026-01-28T23:47:00Z'),Date.parse('2026-01-28T23:47:59.999Z')]);
  assert.equal(dateAppears('11:47 PM EST, January 28, 2026','2026-01-29T04:47:00Z'),true);
  assert.equal(dateAppears('12:00 AM GMT, January 28, 2026','2026-01-28T00:00:00Z'),true);
  assert.equal(dateAppears('11:47 PM UTC, January 28','2026-01-28T23:47:00Z'),false);
  assert.equal(dateAppears('11:47 PM, January 28, 2026','2026-01-28T23:47:00Z'),false);
  assert.equal(dateAppears('13:47 PM UTC, January 28, 2026','2026-01-28'),false);
  const date='11:47 PM UTC, January 28, 2026',text=date+'. '+claim;
  const doc={...source,body:text},visible:VisibleEvidence=new Map();registerVisibleSource(visible,doc,0,text);
  const c={...citation,sourceQuote:text,timeQuote:date,time:'2026-01-28T23:47:00Z',timeContextQuote:undefined};
  assert.throws(()=>validateEvidence({status:'supported',reason:'minute straddles anchor',evidence:[c]},claim,
    '2026-01-28T23:47:30Z',new Map([['s',doc]]),visible),/wrong side/);
});
test('JSON parser accepts an enclosing fence but asks for correction on explanatory prose',()=>{
  assert.deepEqual(parseEvidenceVerdict('```json\n{"status":"unknown"}\n```'),{status:'unknown'});
  assert.throws(()=>parseEvidenceVerdict('Here is the answer: {"status":"supported"}'),/JSON object only/);
});

test('a minute timestamp cannot be made precise enough to cross an anchor inside that minute',()=>{
  const text='January 28, 2026 12:30 PM UTC. '+claim;
  const doc={...source,body:text},visible:VisibleEvidence=new Map();registerVisibleSource(visible,doc,0,text);
  const c={...citation,sourceQuote:text,timeQuote:'January 28, 2026 12:30 PM UTC',time:'2026-01-28T12:30:00Z',timeContextQuote:undefined};
  assert.throws(()=>validateEvidence({status:'supported',reason:'not precise',evidence:[c]},claim,'2026-01-28T12:30:30Z',new Map([['s',doc]]),visible),/wrong side/);
  assert.equal(validateEvidence({status:'supported',reason:'earlier',evidence:[c]},claim,'2026-01-28T12:31:00Z',new Map([['s',doc]]),visible).evidence[0]!.timeRangeUtc!.latest,'2026-01-28T12:30:59.999Z');
});
