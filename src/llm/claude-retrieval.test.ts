import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClaudeSubscriptionClient,CLAUDE_MODEL,CLAUDE_NONE_SYSTEM} from './claude-subscription.js';
import {inspectClaudeRetrievalEvent,claudeRetrievalTools,claudeMcpDiscovery} from './claude-retrieval.js';
import type {LlmMessage} from './benchmark-client.js';
import {AgenticSearchPredictor} from '../predictors/agentic-search.js';
import {BudgetTier, NullRetrievalEnv} from '../predictors/types.js';
import {sha256} from '../tracing/trace-archive.js';
const runtime={cli_version:'fake',wrapper_build:'fake',executable_sha256:'fake',wrapper_sha256:'fake',authentication:'test',credential_fingerprint:'test'};
const tools=['web_search','web_fetch'].map(name=>({name,description:'Original FABench definition',parameters:{type:'object',properties:{query:{type:'string'}}}}));

test('Claude reads a 500-character frozen preview through to the original 1.3M-character last page',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'claude-paged-test-')),oldPath=process.env.PATH;
  const body='Historical original 🙂\n'.repeat(60000)+'LAST_ORIGINAL_PARAGRAPH';
  const script=`#!${process.execPath}
const args=process.argv.slice(2),cfg=JSON.parse(args[args.indexOf('--mcp-config')+1]);
const out=x=>console.log(JSON.stringify(x));
process.stdin.resume();process.stdin.on('end',async()=>{try{
 let n=0;const rpc=async(method,params)=>{const r=await fetch(cfg.mcpServers.raven.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++n,method,params})});return (await r.json()).result;};
 const discovery=await rpc('server/discover',{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}});
 if(discovery.resultType!=='complete'||discovery.supportedVersions[0]!=='2026-07-28'||Object.keys(discovery.capabilities).join(',')!=='tools')throw Error('MCP discovery differs');
 const listed=await rpc('tools/list',{});
 if(listed.resultType!=='complete'||listed.ttlMs!==0||listed.cacheScope!=='private')throw Error('MCP tool list result shape differs');
 out({type:'system',subtype:'init',session_id:'paged-session',tools:listed.tools.map(t=>'mcp__raven__'+t.name),mcp_servers:[{name:'raven',status:'connected'}]});
 const call=async(name,input)=>{
  out({type:'assistant',message:{model:'claude-opus-5',content:[{type:'tool_use',name:'mcp__raven__'+name,id:'tool-'+n,input}]}});
  const r=await rpc('tools/call',{name,arguments:input});
  if(r.resultType!=='complete')throw Error('MCP tool call result type differs');
  if(JSON.stringify(r.content).length>=500000)throw Error('would trigger native persisted-output');
  out({type:'user',message:{content:[{type:'tool_result',content:r.content}]}});
  return JSON.parse(r.content[0].text);
 };
 const result=await call('web_search',{query:'historical context'});
 const first=result.results[0];let text=first.snippet,offset=first.next_offset;
 if([...first.snippet].length>500||first.contentKind!=='leading-excerpt')throw Error('expected original leading preview');
 while(offset!==null){const page=await call('web_fetch',{content_ref:first.content_ref,offset});text+=page.text;offset=page.next_offset;}
 if(!text.endsWith('LAST_ORIGINAL_PARAGRAPH')||require('node:crypto').createHash('sha256').update(text).digest('hex')!==${JSON.stringify(sha256(body))})throw Error('lost original text');
 out({type:'result',subtype:'success',result:JSON.stringify({probability_yes:0.6,numeric_forecast:null,rationale:'Read the archived original.'}),usage:{},modelUsage:{'claude-opus-5':{}}});
 }catch(e){console.error(e);process.exitCode=5;}});
`;
  writeFileSync(join(dir,'claude-raven'),script,{mode:0o700});process.env.PATH=dir+':'+oldPath;
  const events:any[]=[];
  const predictor=new AgenticSearchPredictor(new ClaudeSubscriptionClient(runtime),{
    name:'frozen',fullTextResults:true,
    async search(){return [{url:'https://example.test/history',title:'Historical context',snippet:body}];},
    async fetch(){throw Error('file continuation must not refetch');},stats(){return {};},
  },{toolDelivery:'paged',frozenSearchDelivery:'lead',maxToolCalls:100,trace:{record:e=>events.push(e)}});
  try{
    const result=await predictor.predict({question_id:'paged-fixture',question_text:'Synthetic historical forecast?',
      resolution_criteria:'Synthetic outcome',resolution_date:'2026-04-01',as_of_date:'2026-03-01T00:00:00Z',
      ground_truth:1,market_price_at_freeze:null,category:'test',difficulty_level:'easy',source:'unit',language:'en',
      response_format:'raven.forecast.v2.1',forecast_prompt:'Question bytes unchanged',prediction_cutoff_utc:'2026-04-01T00:00:00Z',
    },NullRetrievalEnv,BudgetTier.Unlimited);
    assert.equal(result.probabilities[0],0.6);
    const reads=events.filter(e=>e.type==='tool_call_finished'&&e.data.name==='web_fetch');
    assert.ok(reads.length>50);assert.equal(reads.at(-1).data.fetched.end_offset,body.length);
    assert.equal(events.filter(e=>e.type==='tool_content_saved').length,1);
    const invocation=events.find(e=>e.type==='llm_transport'&&e.data.event.type==='claude_retrieval_invocation').data.event.data;
    assert.equal(invocation.prompt,'Question bytes unchanged');
    assert.equal(invocation.system, 'Follow the historical information boundary and JSON response contract in the question.\n\n' +
      'You have a news search tool over an archive that ends at the as-of date. Nothing later\n' +
      'exists in it. You are FORECASTING an outcome that is still open on that date — you are not\n' +
      'checking whether it already happened, and searching for the resolving event will find\n' +
      'nothing, because it has not occurred yet.');
    assert.ok(invocation.tools.every((t:any)=>['web_search','web_fetch'].includes(t.name)));
    assert.equal((predictor as any).pages.entries.size,0,'question files and references are cleaned up');
  }finally{process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});}
});

test('native persistence ceiling is transport metadata and leaves tool descriptions and schemas unchanged',()=>{
  assert.deepEqual(claudeMcpDiscovery().capabilities,{tools:{}});
  for(const [i,t] of claudeRetrievalTools(tools).entries()) {
    assert.deepEqual(t._meta,{'anthropic/maxResultSizeChars':500_000});
    assert.equal(t.description,tools[i]!.description);
    assert.deepEqual(t.inputSchema,tools[i]!.parameters);
  }
});

test('retrieval rejects native search, other MCP servers, model swaps and compaction',()=>{
  const names=new Set(tools.map(t=>'mcp__raven__'+t.name));
  inspectClaudeRetrievalEvent({type:'system',subtype:'init',tools:[...names],mcp_servers:[{name:'raven',status:'connected'}]},names);
  for(const event of [
    {type:'system',subtype:'init',tools:['WebSearch'],mcp_servers:[]},
    {type:'system',subtype:'compact_boundary'},
    {type:'assistant',message:{model:CLAUDE_MODEL,content:[{type:'tool_use',name:'WebFetch'}]}},
    {type:'assistant',message:{model:'other',content:[]}},
    {type:'result',subtype:'success',modelUsage:{other:{}}},
  ])assert.throws(()=>inspectClaudeRetrievalEvent(event,names));
  assert.throws(()=>inspectClaudeRetrievalEvent({type:'unknown_event'},names),/Unsupported Claude event/);
  assert.throws(()=>inspectClaudeRetrievalEvent({type:'assistant',error:'rate_limit',message:{model:'<synthetic>',
    content:[{type:'text',text:"You've hit your limit"}]}},names),/Claude rate limit/);
});

test('retrieval accepts only FABench tool heartbeat telemetry',()=>{
  const names=new Set(tools.map(t=>'mcp__raven__'+t.name));
  const heartbeat={type:'tool_progress',tool_use_id:'toolu_search-heartbeat-0',
    tool_name:'mcp__raven__web_search',parent_tool_use_id:'toolu_search',
    elapsed_time_seconds:30,heartbeat:true,session_id:'one-session',uuid:'progress-id'};
  for(const name of names)inspectClaudeRetrievalEvent({...heartbeat,tool_name:name},names);
  for(const changed of [
    {tool_name:'WebSearch'}, {tool_name:'mcp__other__web_search'}, {heartbeat:false},
    {heartbeat:undefined}, {tool_use_id:''}, {parent_tool_use_id:null},
    {elapsed_time_seconds:-1}, {elapsed_time_seconds:'30'}, {elapsed_time_seconds:Infinity},
    {task_id:'background-task'}, {subagent_type:'Explore'}, {subagent_retry:{}},
  ])assert.throws(()=>inspectClaudeRetrievalEvent({...heartbeat,...changed},names),/Unsupported Claude tool progress/);
});

test('Claude native MCP requests round-trip through FABench with exact reviewed input and result bytes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'claude-mcp-test-')),oldPath=process.env.PATH;
  const script=`#!${process.execPath}
const args=process.argv.slice(2),cfg=JSON.parse(args[args.indexOf('--mcp-config')+1]);
const out=x=>console.log(JSON.stringify(x));
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);
process.stdin.on('end',async()=>{try{
 if(input!=='Question bytes\\nunchanged'||args[args.indexOf('--system-prompt')+1]!==${JSON.stringify(CLAUDE_NONE_SYSTEM)})throw Error('prompt changed');
 if(!args.includes('--restricted')||!args.includes('--allowedTools'))throw Error('isolation');
 let n=0;const rpc=async(method,params)=>{const r=await fetch(cfg.mcpServers.raven.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++n,method,params})});return (await r.json()).result;};
 await rpc('initialize',{protocolVersion:'2025-03-26'});
 const listed=await rpc('tools/list',{});if(listed.resultType!=='complete'||listed.ttlMs!==0||listed.cacheScope!=='private'||JSON.stringify(listed.tools.map(t=>t.description))!==JSON.stringify(['Original FABench definition','Original FABench definition']))throw Error('definitions');
 out({type:'system',subtype:'init',session_id:'one-session',tools:listed.tools.map(t=>'mcp__raven__'+t.name),mcp_servers:[{name:'raven',status:'connected'}]});
 for(const name of ['web_search','web_fetch']){
 out({type:'assistant',message:{model:'claude-opus-5',content:[{type:'thinking',thinking:'returned '+name},{type:'tool_use',name:'mcp__raven__'+name,id:name,input:{query:name}}]}});
 const pending=rpc('tools/call',{name,arguments:{query:name}});
 for(const elapsed of [30,60])out({type:'tool_progress',tool_use_id:name+'-heartbeat-'+elapsed,
   tool_name:'mcp__raven__'+name,parent_tool_use_id:name,elapsed_time_seconds:elapsed,
   heartbeat:true,session_id:'one-session',uuid:name+'-progress-'+elapsed});
 const r=await pending;
 if(r.resultType!=='complete')throw Error('MCP tool call result type differs');
 if(r.content[0].text!=='VERBATIM '+name+'\\n正文')throw Error('result bytes changed');
 out({type:'user',message:{content:[{type:'tool_result',content:r.content}]}});
 if(name==='web_fetch'&&r.content[1].text!=='You have used your research budget. Do not search again.')throw Error('budget notice');
 }
 out({type:'result',subtype:'success',result:'forecast',num_turns:3,usage:{input_tokens:20,output_tokens:7,cache_read_input_tokens:100,cache_creation_input_tokens:30},modelUsage:{'claude-opus-5':{}}});
 }catch(e){console.error(e);process.exitCode=5;}});
`;
  writeFileSync(join(dir,'claude-raven'),script,{mode:0o700});process.env.PATH=dir+':'+oldPath;
  const session=new ClaudeSubscriptionClient(runtime).openForecast();
  const messages:LlmMessage[]=[{role:'system',content:CLAUDE_NONE_SYSTEM},{role:'user',content:'Question bytes\nunchanged'}];
  const events:any[]=[],onTrace=(e:any)=>events.push(e);
  try {
    for(const name of ['web_search','web_fetch']) {
      const part=await session.complete({prompt:'',messages,tools,onTrace});
      assert.equal(part.toolCalls?.[0]?.name,name);assert.equal(part.inputTokens,0);
      assert.equal(part.cachedInputTokens,undefined);assert.equal(part.cacheWriteInputTokens,undefined);
      messages.push({role:'assistant',content:part.text,toolCalls:part.toolCalls},
        {role:'tool',toolCallId:part.toolCalls![0]!.id,content:'VERBATIM '+name+'\n正文'});
    }
    messages.push({role:'user',content:'You have used your research budget. Do not search again.'});
    const result=await session.complete({prompt:'',messages,onTrace});
    assert.equal(result.cachedInputTokens,100);assert.equal(result.cacheWriteInputTokens,30);
    assert.equal(events.filter(e=>e.type==='claude_cell_accounting').length,1);
    assert.equal(result.text,'forecast');assert.equal(result.inputTokens,150);assert.equal(result.outputTokens,7);
    assert.equal(events.filter(e=>e.type==='claude_retrieval_invocation').length,1);
    assert.equal(events.filter(e=>e.type==='claude_raven_tool_response').length,2);
    assert.equal(events.filter(e=>e.type==='claude_raven_tool_request').length,2);
    assert.equal(events.filter(e=>e.type==='claude_event'&&e.data.type==='tool_progress').length,4);
    // A native CLI that summarizes/truncates MCP evidence must not silently score a forecast.
    writeFileSync(join(dir,'claude-raven'),script.replace('content:r.content','content:[{type:"text",text:"truncated"}]'),{mode:0o700});
    const corrupted=new ClaudeSubscriptionClient(runtime).openForecast();
    try {
      const history=messages.slice(0,2);
      const first=await corrupted.complete({prompt:'',messages:history,tools});
      history.push({role:'assistant',content:first.text,toolCalls:first.toolCalls},
        {role:'tool',toolCallId:first.toolCalls![0]!.id,content:'VERBATIM web_search\n正文'});
      await assert.rejects(()=>corrupted.complete({prompt:'',messages:history,tools}),/native tool result differs/);
    } finally {corrupted.close();}

  } finally {session.close();process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});}
});
