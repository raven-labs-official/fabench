import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorpusStore } from './store.js';
import { queryIdentity } from './query-identity.js';

test('country and institution survive rarity and every relaxation level', () => {
  const store = new CorpusStore();
  try {
    store.ingest([
      {url:'https://test/right',title:'UK Met Office outlook',body:'April 2026 temperature forecast for spring.',crawlDate:'2026-02-20'},
      {url:'https://test/wrong-country',title:'Kenya Met Office April forecast',body:'April 2026 temperature forecast met office April forecast temperature.',crawlDate:'2026-02-20'},
      {url:'https://test/wrong-institution',title:'UK spring forecast',body:'Temperature forecast April 2026 from an amateur.',crawlDate:'2026-02-20'},
      {url:'https://test/future',title:'UK Met Office April forecast',body:'April 2026 temperature forecast met office.',crawlDate:'2026-04-20'},
    ]);
    assert.deepEqual(store.search('UK Met Office April 2026 temperature forecast','2026-03-01').map(x=>x.url),['https://test/right']);
  } finally { store.close(); }
});

test('literal countries do not expand into unrelated adjectives; US keeps legitimate pages', () => {
  const store = new CorpusStore();
  try {
    store.ingest([
      {url:'https://test/china',title:'China gasoline prices',body:'Gasoline price trend.',crawlDate:'2026-02-20'},
      {url:'https://test/us',title:'US gasoline prices',body:'Gasoline price trend.',crawlDate:'2026-02-20'},
    ]);
    assert.deepEqual(store.search('China gasoline prices','2026-03-01').map(x=>x.url),['https://test/china']);
    assert.ok(store.search('US gasoline prices','2026-03-01').some(x=>x.url==='https://test/us'));
    assert.deepEqual(queryIdentity('France temperature forecast').constraints, ['\"france\"']);
    assert.equal(queryIdentity('US gasoline prices').constraints.length,0);
    assert.equal(queryIdentity('tell us gasoline prices').constraints.length,0);
  } finally { store.close(); }
});

test('unknown metric terms remain mandatory and constraints alone are valid', () => {
  const store = new CorpusStore();
  try {
    store.ingest([{url:'https://test/uk',title:'UK tariffs',body:'Tariff negotiations continue.',crawlDate:'2026-02-20'}]);
    assert.deepEqual(store.search('UK USEPUINDXD tariff negotiations','2026-03-01'),[]);
    assert.equal(store.search('UK','2026-03-01').length,1);
    assert.deepEqual(queryIdentity('USEPUINDXD tariff negotiations').constraints,[]);
  } finally { store.close(); }
});

test('S&P 500 survives tokenization and cannot become a generic weather forecast', () => {
  const store = new CorpusStore();
  try {
    store.ingest([
      {url:'https://test/stocks',title:'S&P 500 forecast 2026',body:'Index forecast for 2026.',crawlDate:'2026-02-20'},
      {url:'https://test/weather',title:'Weather forecast 2026',body:'Forecast 2026 forecast 2026 forecast.',crawlDate:'2026-02-20'},
    ]);
    assert.deepEqual(store.search('S&P 500 forecast 2026','2026-03-01').map(x=>x.url),['https://test/stocks']);
  } finally { store.close(); }
});
