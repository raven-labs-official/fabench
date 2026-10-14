import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordedSearchBackend, frozenSnapshotBackend, textHash, validateSnapshot, type SearchSnapshot } from './search-snapshot.js';

function fixture(): SearchSnapshot {
  return { schema:'raven.search-snapshot.v1', startedAtUtc:'2026-08-30T10:00:00Z', frozenAtUtc:'2026-08-30T10:01:00Z',provider:'fixture',
    searches:[{query:'Acme guidance',requested:5,observedAtUtc:'2026-08-30T10:00:10Z',results:[{url:'https://example.test/acme',title:'Acme guidance',snippet:'Revenue expected to rise.'}]}],
    pages:[{observedAtUtc:'2026-08-30T10:00:30Z',sha256:textHash('Acme guidance expects revenue to rise.'),doc:{url:'https://example.test/acme',title:'Acme guidance',body:'Acme guidance expects revenue to rise.'}}],fetchFailures:[] };
}

test('exact control preserves response bytes and rejects unobserved queries/earlier anchors',async()=>{
  const s=fixture(), b=new RecordedSearchBackend(s);
  assert.deepEqual(await b.search('Acme guidance',5,s.frozenAtUtc),s.searches[0]!.results);
  await assert.rejects(b.search('unrecorded',5,s.frozenAtUtc),/not captured/);
  await assert.rejects(b.fetch('https://example.test/acme',s.startedAtUtc),/exact/);
  assert.deepEqual(await b.fetch('https://example.test/acme',s.frozenAtUtc),s.pages[0]!.doc);
});

test('backdated observations and modified bodies cannot be admitted to the snapshot',()=>{
  const s=fixture();s.pages[0]!.observedAtUtc='2026-08-31T00:00:00Z';
  assert.throws(()=>validateSnapshot(s),/outside/);
  const changed=fixture();changed.pages[0]!.doc.body='Future outcome';
  assert.throws(()=>validateSnapshot(changed),/hash mismatch/);
});

test('isolated captured corpus supports new queries and enforces crawl cutoff',async()=>{
  const s=fixture(), {backend,close}=frozenSnapshotBackend(s);
  try {
    assert.equal((await backend.search('revenue rise',5,s.frozenAtUtc)).length,1);
    await assert.rejects(backend.search('revenue rise',5,s.startedAtUtc),/exact freeze anchor/);
  } finally {close();}
});

test('snapshot retains search-only evidence without inventing a page, and owns its input',async()=>{
  const s=fixture();s.pages=[];
  const anchor=s.frozenAtUtc, {backend,close}=frozenSnapshotBackend(s);
  s.frozenAtUtc='2026-08-01T00:00:00Z';
  s.searches[0]!.results[0]!.snippet='Mutation after freezing';
  try {
    const hits=await backend.search('revenue rise',5,anchor);
    assert.equal(hits.length,1);
    assert.match(hits[0]!.snippet,/Revenue expected/);
    assert.equal(await backend.fetch('https://example.test/acme',anchor),null);
    assert.equal(backend.stats().fetches,1);
  } finally {close();}
});

test('provider response integrity is checked and hidden response fields never enter model-visible retrieval',async()=>{
  const s=fixture(), row=s.searches[0]!, response={knowledgeGraph:{title:'HIDDEN_OUTCOME_TOKEN'},
    organic:row.results.map(r=>({link:r.url,title:r.title,snippet:r.snippet}))};
  row.providerCapture={endpoint:'https://google.serper.dev/search',request:{q:row.query,num:row.requested},
    observedAtUtc:row.observedAtUtc,response,responseSha256:textHash(JSON.stringify(response))};
  validateSnapshot(s);
  const {backend,close}=frozenSnapshotBackend(s);
  try{assert.deepEqual(await backend.search('HIDDEN_OUTCOME_TOKEN',5,s.frozenAtUtc),[]);}finally{close();}
  row.results[0]!.snippet='Altered normalized result';
  assert.throws(()=>validateSnapshot(s),/normalized results disagree/);
  row.providerCapture.response={knowledgeGraph:{title:'Changed'}};
  assert.throws(()=>validateSnapshot(s),/search response hash mismatch/);
});

test('provider response cannot be silently associated with another query or observation time',()=>{
  const s=fixture(),row=s.searches[0]!;
  row.providerCapture={endpoint:'https://google.serper.dev/search',request:{q:'another query',num:5},
    observedAtUtc:row.observedAtUtc,response:{},responseSha256:textHash('{}')};
  assert.throws(()=>validateSnapshot(s),/does not match search request/);
  row.providerCapture.request.q=row.query;
  row.providerCapture.observedAtUtc='2026-08-30T10:00:11Z';
  assert.throws(()=>validateSnapshot(s),/does not match search request/);
});
