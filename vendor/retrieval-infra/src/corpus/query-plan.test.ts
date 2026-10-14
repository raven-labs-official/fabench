import test from 'node:test';
import assert from 'node:assert/strict';
import { CorpusStore } from './store.js';
import { planQuery, sameContent, sameDocumentContent, sameArticleEdition, relevance } from './query-plan.js';

const anchor = '2026-03-01T00:00:00Z';
function store(docs: { title: string; body: string }[], aliases?: { variants: string[]; provenance: string }[]) {
  const db = new CorpusStore(':memory:', 'concept', 'auto', { aliases });
  db.ingest(docs.map((d, i) => ({ ...d, url: `https://synthetic.example/${i}`, crawlDate: '2026-02-01T00:00:00Z' })));
  return db;
}

test('period syntax finds stored fiscal wording while keeping all candidate routes inspectable', () => {
  const db = store([{ title: 'Acme fiscal year 2026 outlook', body: 'Acme estimates earnings for fiscal year 2026. The preliminary estimate is described in the full report.' }]);
  try {
    const result = db.searchPlanned('Acme FY2026 earnings estimates', anchor, 5);
    assert.equal(result.hits.length, 1);
    assert.ok(result.plan.concepts.some(c => c.variants.includes('fiscal year 2026')));
    assert.ok(result.routes.length <= 6);
  } finally { db.close(); }
});

test('general plural variants and provenance-bearing institution aliases work outside earnings', () => {
  const db = store([
    { title: 'Orion telescope observation', body: 'An Orion telescope observation measured atmospheric dust.' },
    { title: 'European Central Bank policy', body: 'The European Central Bank policy discussion describes inflation.' },
  ], [{ variants: ['ECB', 'European Central Bank'], provenance: 'synthetic historical glossary v1' }]);
  try {
    assert.equal(db.search('Orion telescope observations', anchor)[0]?.url, 'https://synthetic.example/0');
    assert.equal(db.search('ECB policy', anchor)[0]?.url, 'https://synthetic.example/1');
    assert.deepEqual(db.search('NeverRecordedIdentifier policy', anchor), []);
  } finally { db.close(); }
});

test('different query facets change ranking instead of returning the same rare pair in order', () => {
  const db = store([
    { title: 'Orion telescope budget', body: 'Orion telescope budget funding was discussed by the council.' },
    { title: 'Orion telescope launch', body: 'Orion telescope launch preparation was discussed by the council.' },
    { title: 'Orion telescope staffing', body: 'Orion telescope staffing recruitment was discussed by the council.' },
  ]);
  try {
    assert.equal(db.search('Orion telescope budget', anchor, 1)[0]?.url, 'https://synthetic.example/0');
    assert.equal(db.search('Orion telescope launch', anchor, 1)[0]?.url, 'https://synthetic.example/1');
    assert.equal(db.search('Orion telescope staffing', anchor, 1)[0]?.url, 'https://synthetic.example/2');
  } finally { db.close(); }
});

test('same headline alone never removes distinct bodies; full copy outranks a matching short shell', () => {
  const common = 'Orion telescope observation describes atmospheric dust and the method used to collect particles from the upper atmosphere during the mission. ';
  const db = store([
    { title: 'Orion observation report', body: common },
    { title: 'Orion observation report', body: common.repeat(8) },
    { title: 'Orion observation report', body: 'Orion observation describes ocean circulation and marine habitats. '.repeat(8) },
  ]);
  try {
    const hits = db.search('Orion observation report', anchor, 10);
    assert.equal(hits.length, 2);
    assert.ok(hits.some(h => h.url.endsWith('/1')));
    assert.ok(hits.some(h => h.url.endsWith('/2')));
  } finally { db.close(); }
});

test('near-identical articles with changed values remain distinct', () => {
  const body = 'The fictional agency described the release and its methodology in detail. '.repeat(12);
  const doc = { url: 'x', title: 'Release', body: body + 'The value was 12.5 percent.', score: 0, crawlDate: anchor };
  assert.equal(sameContent(doc, { ...doc, body: body + 'The value was 13.5 percent.' }), false);
});

test('same URL layout editions merge but different reports and titles do not',()=>{
  const doc={url:'https://publisher.example/story/report.html',title:'Report',body:'Original',score:0,crawlDate:anchor};
  assert.equal(sameArticleEdition(doc,{...doc,url:'https://publisher.example/amp/story/report.html',body:'Mobile navigation Original'}),true);
  assert.equal(sameArticleEdition(doc,{...doc,url:'https://publisher.example/story/other.html'}),false);
  assert.equal(sameArticleEdition(doc,{...doc,title:'Corrected report'}),false);
});

test('requested period next to a metric outranks a distant mention of that period',()=>{
  const plan=planQuery('Orion expenditure 2026 outlook',()=>10);
  const common={url:'https://publisher.example/report',title:'Orion expenditure outlook',score:0,crawlDate:anchor};
  const direct={...common,body:'Orion expenditure outlook for 2026 is 52 billion. '+('Background. '.repeat(80))};
  const distant={...common,body:'Orion expenditure outlook for 2025 is 42 billion. '+('Background. '.repeat(80))+' Planning continues into 2026.'};
  assert.ok(relevance(direct,plan)>relevance(distant,plan));
});

test('country constraints survive relaxed routes and quoted phrases survive alias normalization', () => {
  const db = store([
    { title: 'Canada telescope budget', body: 'Canada telescope budget discussions describe annual funding.' },
    { title: 'Japan telescope budget', body: 'Japan telescope budget discussions describe annual funding.' },
  ]);
  try { assert.deepEqual(db.search('Japan telescope budget', anchor).map(h => h.url), ['https://synthetic.example/1']); }
  finally { db.close(); }
  const plan = planQuery('ECB "interest rate"', () => 10, { aliases: [{ variants: ['ECB', 'European Central Bank'], provenance: 'synthetic glossary' }] });
  assert.ok(plan.expressions.every(e => e.includes('"interest rate"')));
});

test('query planning rejects unbounded expansion and never treats zero-frequency literals as optional', () => {
  assert.throws(() => planQuery('foo', () => 1, { aliases: [{ variants: ['foo', 'bar'], provenance: '' }] }), /provenance/);
  assert.deepEqual(planQuery('unknown known', word => word === 'known' ? 20 : 0).expressions, []);
  assert.throws(() => planQuery('foo', () => 1, { candidateBudget: 100000 }), /candidateBudget/);
});

test('cached content comparison gives the same answer as the uncached one for every pair', () => {
  const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
  const base = { url: 'https://a.example/x', title: 'Café Report', crawlDate: '', score: 0, body: `Déjà vu. ${words} The rate was 4.5 percent.` };
  const docs = [
    base,
    { ...base, url: 'https://b.example/y', body: base.body.replace('Déjà', 'Deja') },
    { ...base, body: base.body.replace('4.5', '4.6') },
    { ...base, body: `${base.body} Extra closing paragraph with more words here.` },
    { ...base, body: words.slice(0, 40) },
    { ...base, body: '' },
    { ...base, title: 'Other', body: Array.from({ length: 120 }, (_, i) => `other${i}`).join(' ') },
  ];
  for (let round = 0; round < 2; round++)
    for (const a of docs) for (const b of docs)
      assert.equal(sameDocumentContent(a, b), sameContent(a, b), `${docs.indexOf(a)} vs ${docs.indexOf(b)}, round ${round}`);
  assert.equal(sameDocumentContent(docs[0]!, docs[1]!), true);
  assert.equal(sameDocumentContent(docs[0]!, docs[2]!), false);
});
