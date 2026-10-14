import test from 'node:test';
import assert from 'node:assert/strict';
import {frozenLead, FROZEN_LEAD_POLICY} from './frozen-search-preview.js';
import {AgenticSearchPredictor} from './agentic-search.js';
import type {SearchBackend} from '../retrieval/search-backend.js';
import {sha256} from '../tracing/trace-archive.js';

test('leading excerpts preserve exact source coordinates and complete sentences under a Unicode character cap',()=>{
  for (const body of ['', '  short original🙂  ', '  First complete sentence. '+ 'unbroken'.repeat(300), '  '+ '🙂'.repeat(600)]) {
    const lead=frozenLead(body);
    assert.equal(lead.text,body.slice(lead.offset,lead.end_offset));
    assert.ok([...lead.text].length<=500);assert.ok(lead.text.isWellFormed());
    if(body.includes('First'))assert.equal(lead.text,'First complete sentence.');
    if(body.includes('short'))assert.equal(lead.text,'short original🙂  ');
    if(body.includes('🙂'.repeat(600)))assert.equal(lead.end_offset,1002);
  }
  assert.equal(frozenLead('首句。第二句！'+'中'.repeat(600)).text,'首句。第二句！');
  const exact='First. '+ 'A'.repeat(492)+'.';
  assert.equal(exact.length,500);assert.equal(frozenLead(exact+' Another sentence.').text,exact);
});

test('query and entity previews pin every original capture, even short bodies and reused URLs',async()=>{
  const bodies=['  Historical first sentence. '+ 'A'.repeat(1200)+' FIRST_TAIL','Different capture. '+ 'B'.repeat(1300)+' SECOND_TAIL','Short complete article.'];
  let fetches=0;
  const backend:SearchBackend={name:'frozen',fullTextResults:true,
    async search(){return bodies.map((snippet,i)=>({url:'https://example.test/same',title:'v'+i,snippet,source:'frozen',crawlDate:'2026-02-0'+(i+1),documentId:'d'+i,offset:0,nextOffset:null,truncated:false}));},
    async browse(){return {results:bodies.map((body,i)=>({url:'https://example.test/same',title:'v'+i,body,crawlDate:'2026-02-0'+(i+1),capturedId:'capture'+i})),nextCursor:'next captures',query:{entity:'historical'}} as any;},
    async fetch(){fetches++;throw Error('must read the saved capture');},stats(){return {};}};
  const events:any[]=[];
  const predictor=new AgenticSearchPredictor({id:'no-model-call',async complete(){throw Error('no extra model');}},backend,
    {toolDelivery:'paged',frozenSearchDelivery:'lead',trace:{record:e=>events.push(e)}});
  const call=(name:string,args:any)=>(predictor as any).runTool(name,args,'2026-03-01');
  try {
    for(const args of [{query:'historical'},{entity:'historical'}]) {
      const result=await call('web_search',args), parsed=JSON.parse(result.content);
      if('entity' in args)assert.equal(parsed.next_cursor,'next captures');
      assert.equal(result.results[0].snippet,parsed.results[0].snippet);
      for(const [i,row] of parsed.results.entries()) {
        assert.equal(row.snippet,frozenLead(bodies[i]!).text);
        assert.equal(row.contentKind,'leading-excerpt');assert.equal(row.previewPolicy,FROZEN_LEAD_POLICY.version);
        assert.equal(row.nextOffset,undefined);assert.equal(row.sha256,sha256(bodies[i]!));
        const full=JSON.parse((await call('web_fetch',{content_ref:row.content_ref,offset:0})).content);
        assert.equal(full.text,bodies[i]);assert.equal(full.sha256,row.sha256);
        if(row.next_offset!==null) {
          const tail=JSON.parse((await call('web_fetch',{content_ref:row.content_ref,offset:row.next_offset})).content);
          assert.equal(bodies[i]!.slice(0,row.offset)+row.snippet+tail.text,bodies[i]);
        }
      }
    }
    assert.equal(fetches,0);assert.equal(events.filter(e=>e.type==='tool_content_saved').length,6);
    assert.match(predictor.id,/frozen-leading-text-v1/);
  }finally{await (predictor as any).pages.close();}
});

test('oversized search metadata preserves the preview envelope without re-exposing full search bodies',async()=>{
  const body='Article opening. '+ 'ORIGINAL_BODY_ONLY'.repeat(60000);
  const backend:SearchBackend={name:'frozen',fullTextResults:true,
    async search(){return [{title:'x'.repeat(250000),url:'https://example.test/large',snippet:body}];},async fetch(){throw Error('no refetch');},stats(){return {};}};
  const predictor=new AgenticSearchPredictor({id:'fake',async complete(){throw Error('unused');}},backend,{toolDelivery:'paged',frozenSearchDelivery:'lead'});
  const call=(name:string,args:any)=>(predictor as any).runTool(name,args,'2026-03-01');
  try{
    let page=JSON.parse((await call('web_search',{query:'article'})).content), envelope=page.text;
    assert.equal(page.kind,'tool-result');
    while(page.next_offset!==null){page=JSON.parse((await call('web_fetch',{content_ref:page.content_ref,offset:page.next_offset})).content);envelope+=page.text;}
    const hit=JSON.parse(envelope).results[0];assert.equal(hit.snippet,'Article opening.');
    const original=JSON.parse((await call('web_fetch',{content_ref:hit.content_ref,offset:body.length-100})).content);
    assert.equal(original.text,body.slice(-100));
  }finally{await (predictor as any).pages.close();}
});

test('mixed preserves frozen lead previews and approved web summaries independently',async()=>{
  const body='Captured opening. '+'Original full article. '.repeat(80),summary='Web approved summary. '.repeat(40);
  const backend:SearchBackend={name:'mixed',searchDelivery:'summary',fullTextResults:false,stats:()=>({}),
    async search(){return [{url:'https://example.test/f',title:'frozen',snippet:body,source:'frozen'},
      {url:'https://example.test/w',title:'web',snippet:summary,source:'web',contentKind:'approved-summary'}];},
    async fetch(){throw Error('must read saved capture');}};
  const predictor=new AgenticSearchPredictor({id:'fake',async complete(){throw Error('unused');}},backend,{toolDelivery:'paged',frozenSearchDelivery:'lead'});
  const call=(name:string,args:any)=>(predictor as any).runTool(name,args,'2026-07-01');
  try {
    const result=JSON.parse((await call('web_search',{query:'q'})).content);
    assert.equal(result.results[0].snippet,frozenLead(body).text);
    assert.equal(result.results[1].snippet,summary);
    assert.equal(result.results[1].contentKind,'approved-summary');
    assert.equal(result.results[1].content_ref,undefined);
    assert.equal(JSON.parse((await call('web_fetch',{content_ref:result.results[0].content_ref})).content).text,body);
  }finally{await (predictor as any).pages.close();}
});
