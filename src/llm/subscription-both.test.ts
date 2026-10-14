import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClaudeSubscriptionClient, type ClaudeModel} from './claude-subscription.js';
import {AstraSubscriptionClient, type AstraLauncher} from './codex-astra.js';
import {AgenticSearchPredictor} from '../predictors/agentic-search.js';
import {BudgetTier,NullRetrievalEnv} from '../predictors/types.js';
import {MixedBackend} from '../../vendor/retrieval-infra/src/retrieval/mixed-backend.js';
import {EvidenceStore} from '../../vendor/retrieval-infra/src/retrieval/evidence-store.js';
import type {SearchBackend} from '../retrieval/search-backend.js';

const prompt='Reviewed question bytes remain unchanged.';
const final=JSON.stringify({probability_yes:0.6,numeric_forecast:null,rationale:'Historical evidence.'});
const body='Original frozen paragraph. '.repeat(1500)+'LAST_FROZEN_PARAGRAPH';
const webBody='Approved web original text. '.repeat(1100)+'LAST_WEB_PARAGRAPH';
const summary='Approved web summary, preserved verbatim.';
const system='Follow the historical information boundary and JSON response contract in the question.\n\n' +
  'You have a news search tool over an archive that ends at the as-of date. Nothing later\n' +
  'exists in it. You are FORECASTING an outcome that is still open on that date — you are not\n' +
  'checking whether it already happened, and searching for the resolving event will find\n' +
  'nothing, because it has not occurred yet.';
const runtime={version:'fixture',executable_sha256:'fixture',entrypoint_sha256:'fixture',wrapper_sha256:'fixture',
 authentication:'chatgpt_subscription',cli_version:'fixture',wrapper_build:'fixture',credential_fingerprint:'fixture'};
// The same fake native model exercises both native wire protocols. FABench's real predictor,
// MixedBackend, content references and budget execute every search/read.
const checkResult=`
const result=await call('web_search',{query:'historical',num_results:6});
if(result.results.length!==4)throw Error('expected 3 frozen + 1 approved web without refill');
const frozen=result.results[0],web=result.results[3];
if(frozen.contentKind!=='leading-excerpt'||[...frozen.snippet].length>500)throw Error('frozen preview changed');
if(web.snippet!==${JSON.stringify(summary)})throw Error('approved web summary changed');
for(const [r,last] of [[frozen,'LAST_FROZEN_PARAGRAPH'],[web,'LAST_WEB_PARAGRAPH']]){
 let page=await call('web_fetch',{url:r.url});if(page.error)throw Error(page.error);let text=page.text,offset=page.next_offset;
 while(offset!==null){page=await call('web_fetch',{content_ref:page.content_ref,offset});if(page.error)throw Error(page.error);text+=page.text;offset=page.next_offset;}
 if(!text.endsWith(last))throw Error('source dispatch or pagination lost original text');
}
`;
function script(kind:'claude'|'codex',model:string){
 if(kind==='claude')return `#!${process.execPath}
const args=process.argv.slice(2),cfg=JSON.parse(args[args.indexOf('--mcp-config')+1]);
const out=x=>console.log(JSON.stringify(x));let input='';
process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);
process.stdin.on('end',async()=>{try{
 if(input!==${JSON.stringify(prompt)}||args[args.indexOf('--system-prompt')+1]!==${JSON.stringify(system)})throw Error('question changed');
 let n=0;const rpc=async(method,params)=>{const r=await fetch(cfg.mcpServers.raven.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++n,method,params})});return (await r.json()).result;};
 const listed=await rpc('tools/list',{});
 if(listed.tools.length!==2)throw Error('unexpected tool surface');
 out({type:'system',subtype:'init',session_id:'both',tools:listed.tools.map(t=>'mcp__raven__'+t.name),mcp_servers:[{name:'raven',status:'connected'}]});
 const call=async(name,input)=>{
  out({type:'assistant',message:{model:${JSON.stringify(model)},content:[{type:'tool_use',name:'mcp__raven__'+name,id:'c'+n,input}]}});
  const r=await rpc('tools/call',{name,arguments:input});
  out({type:'user',message:{content:[{type:'tool_result',content:r.content}]}});
  return JSON.parse(r.content[0].text);
 };
 ${checkResult}
 out({type:'result',subtype:'success',result:${JSON.stringify(final)},usage:{},modelUsage:{[${JSON.stringify(model)}]:{}}});
 }catch(e){console.error(e);process.exitCode=5;}});
`;
 return `const out=x=>console.log(JSON.stringify(x)),event=(method,params)=>out({method,params});
let n=900,pending=new Map();
const call=(tool,args)=>new Promise(resolve=>{const id=++n;pending.set(id,resolve);out({id,method:'item/tool/call',params:{threadId:'both',turnId:'one',callId:'c'+id,tool,arguments:args,namespace:'raven'}});});
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{try{const x=JSON.parse(line);
 if(x.method==='initialize')out({id:x.id,result:{}});
 else if(x.method==='thread/start'){
  if(x.params.baseInstructions!==${JSON.stringify(system)}||x.params.dynamicTools[0].tools.length!==2||!x.params.ephemeral||x.params.environments.length)throw Error('tool surface changed');
  out({id:x.id,result:{thread:{id:'both',environments:[]},model:${JSON.stringify(model)},modelProvider:'openai',instructionSources:[]}});
 }else if(x.method==='turn/start'){
  if(x.params.input[0].text!==${JSON.stringify(prompt)})throw Error('question changed');
  out({id:x.id,result:{turn:{id:'one'}}});
  ${checkResult}
  event('item/completed',{item:{type:'agentMessage',text:${JSON.stringify(final)}}});
  event('turn/completed',{turn:{status:'completed',error:null}});
 }else if(pending.has(x.id)){
  const text=x.result.contentItems[0].text;
  event('rawResponseItem/completed',{item:{type:'function_call_output',call_id:'c'+x.id,output:[{type:'input_text',text}]}});
  pending.get(x.id)(JSON.parse(text));pending.delete(x.id);
 }
}catch(e){console.error(e);process.exit(5);}});
`;
}
for(const model of ['claude-opus-5','claude-opus-5-5','gpt-6-astra','gpt-5.6-sol','gpt-6-sol'] as const){
 test(`${model} subscription preserves both half-split, web summary and source-specific full reads`,{timeout:20000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'both-native-')),oldPath=process.env.PATH;
  const kind=model.startsWith('claude')?'claude':'codex';
  const path=join(dir,kind==='claude'?'claude-raven':'fake.cjs');writeFileSync(path,script(kind,model),{mode:0o700});
  process.env.PATH=dir+':'+oldPath;
  const calls:{source:string,n?:number,url?:string}[]=[],events:any[]=[];
  const frozen:SearchBackend={name:'frozen',fullTextResults:true,stats:()=>({}),
   async search(_q,n){calls.push({source:'frozen',n});return Array.from({length:n},(_,i)=>({url:`https://frozen.test/${i}`,title:'Captured',snippet:body,source:'frozen' as const}));},
   async fetch(url){calls.push({source:'frozen',url});return {url,title:'Captured',body};}};
  const web:SearchBackend={name:'web-filter',searchDelivery:'summary',stats:()=>({}),
   async search(_q,n){calls.push({source:'web',n});return [{url:'https://web.test/approved',title:'Approved',snippet:summary,source:'web' as const,contentKind:'approved-summary' as const}];},
   async fetch(url){calls.push({source:'web',url});return {url,title:'Approved',body:webBody};}};
  const backend=new MixedBackend(frozen,web,new EvidenceStore(join(dir,'evidence')));
  const launcher:AstraLauncher=()=>({command:process.execPath,args:[path],env:process.env,cwd:dir,cleanup:()=>{}});
  const client=kind==='claude'?new ClaudeSubscriptionClient(runtime,model as ClaudeModel):
    new AstraSubscriptionClient(runtime,launcher,{model:model as 'gpt-6-astra'|'gpt-5.6-sol'|'gpt-6-sol'});
  const predictor=new AgenticSearchPredictor(client,backend,{toolDelivery:'paged',frozenSearchDelivery:'lead',maxToolCalls:100,
    ...(model.includes('sol')?{effort:'high'}:{}),trace:{record:e=>events.push(e)}});
  try{
   const result=await predictor.predict({question_id:'both-fixture',question_text:'Synthetic forecast?',resolution_criteria:'Synthetic outcome',
    resolution_date:'2026-04-01',as_of_date:'2026-03-01T00:00:00Z',ground_truth:1,market_price_at_freeze:null,
    category:'test',difficulty_level:'easy',source:'unit',language:'en',response_format:'raven.forecast.v2.1',
    forecast_prompt:prompt,prediction_cutoff_utc:'2026-04-01T00:00:00Z'},NullRetrievalEnv,BudgetTier.Unlimited);
   assert.equal(result.probabilities[0],.6);
   assert.deepEqual(calls.filter(c=>c.n),[{source:'frozen',n:3},{source:'web',n:3}]);
   assert.deepEqual(calls.filter(c=>c.url),[{source:'frozen',url:'https://frozen.test/0'},{source:'web',url:'https://web.test/approved'}]);
   const evidence=readdirSync(join(dir,'evidence')).map(f=>JSON.parse(readFileSync(join(dir,'evidence',f),'utf8'))).find(e=>e.operation==='mixed-search');
   assert.equal(evidence.served,4);assert.equal(evidence.web_candidates_requested,3);
   assert.ok(events.some(e=>e.type==='tool_call_finished'&&e.data.name==='web_fetch'));
   if(kind==='claude'){
    const invocation=events.find(e=>e.type==='llm_transport'&&e.data.event.type==='claude_retrieval_invocation').data.event.data;
    assert.equal(invocation.prompt,prompt);
    // Check the reviewed system against the existing predictor contract, with no method-specific instructions.
    assert.equal(invocation.system,system);
   }
  }finally{process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});}
 });
}
