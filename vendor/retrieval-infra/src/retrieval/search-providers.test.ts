import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {SerperProvider} from './search-providers.js';

test('Serper capture preserves provider JSON and request parameters without including credentials',async()=>{
  const response={searchParameters:{q:'Acme guidance',gl:'us',hl:'en'},organic:[
    {link:'https://example.test/a',title:'Guidance',snippet:'Old forecast',date:'Aug 29, 2026',position:1},
    {title:'No link'}, {link:'https://example.test/b',title:'Second',position:3}],
    knowledgeGraph:{title:'Extra provider material'}};
  class FixtureProvider extends SerperProvider {
    protected override async post(_url:string,_headers:Record<string,string>,_body:unknown){return structuredClone(response);}
  }
  const provider=new FixtureProvider('not-a-real-key');
  const got=await provider.searchWithCapture('Acme guidance',1,'2026-08-30T00:00:00Z');
  assert.deepEqual(got.results,[{url:'https://example.test/a',title:'Guidance',snippet:'Old forecast',date:'Aug 29, 2026'}]);
  assert.deepEqual(got.capture.response,response);
  assert.deepEqual(got.capture.request,{q:'Acme guidance',num:1,tbs:'cdr:1,cd_max:08/30/2026'});
  assert.equal(got.capture.responseSha256,createHash('sha256').update(JSON.stringify(response)).digest('hex'));
  assert.equal(JSON.stringify(got.capture).includes('not-a-real-key'),false);
  assert.deepEqual(await provider.search('Acme guidance',1,'2026-08-30T00:00:00Z'),got.results);
});
