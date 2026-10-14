import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AstraSubscriptionClient, astraArguments, astraTools, astraReasoning, type AstraLauncher } from "./codex-astra.js";
import { CODEX_NONE_SYSTEM } from "./codex-subscription.js";
import { formalArguments } from "../experiments/environment-check.js";
import { PKG_ROOT } from "../paths.js";
import type { LlmMessage } from "./client.js";

const runtime={version:"test",executable_sha256:"test",entrypoint_sha256:"test",wrapper_sha256:"test",authentication:"chatgpt_subscription"};
const tool={name:"web_search",description:"Exact FABench definition",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}};
const system=CODEX_NONE_SYSTEM;
const initial=()=>[{role:"system",content:system},{role:"user",content:"Verbatim\nquestion"}] as LlmMessage[];
function fake(mode="tool",model:"gpt-6-astra"|"gpt-5.6-sol"|"gpt-6-sol"="gpt-6-astra") {
  const dir=mkdtempSync(join(tmpdir(),"fabench-astra-test-"));let launches=0;
  const code=`const readline=require('node:readline');
const mode=${JSON.stringify(mode)};let tid='isolated-thread',turn='turn',n=0;
const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const event=(method,params)=>out({method,params});
const usage=()=>event('thread/tokenUsage/updated',{threadId:tid,tokenUsage:{total:{inputTokens:20,outputTokens:4,cachedInputTokens:3,reasoningOutputTokens:2}}});
const done=()=>{event('item/completed',{item:{type:'agentMessage',text:'{"probability_yes":0.5,"numeric_forecast":null,"rationale":"test"}'}});usage();event('turn/completed',{turn:{status:'completed',error:null}});};
readline.createInterface({input:process.stdin}).on('line',line=>{
const x=JSON.parse(line);
if(x.method==='initialize')out({id:x.id,result:{}});
else if(x.method==='thread/start'){
 if(x.params.baseInstructions!==${JSON.stringify(system)}||x.params.developerInstructions!==''||x.params.environments.length||!x.params.ephemeral)process.exit(7);
 if(mode==='tool'&&JSON.stringify(x.params.dynamicTools[0].tools[0].inputSchema)!==${JSON.stringify(JSON.stringify(tool.parameters))})process.exit(8);
 out({id:x.id,result:{thread:{id:tid,environments:[]},model:${JSON.stringify(model)},modelProvider:'openai',instructionSources:[]}});
}
else if(x.method==='turn/start'){
 if(x.params.input[0].text!=='Verbatim\\nquestion'||${model!=='gpt-6-astra'?"x.params.effort!=='high'":"'effort' in x.params"})process.exit(9);
 out({id:x.id,result:{turn:{id:turn}}});
 if(mode==='forbidden'){event('item/started',{item:{type:'commandExecution'}});return;}
 if(mode==='failure'){event('item/reasoning/textDelta',{delta:'partial thought'});event('turn/completed',{turn:{status:'failed',error:{message:'failed'}}});return;}
 if(mode==='none'){done();return;}
 if(mode==='compact'){event('thread/compacted',{});return;}
 if(mode==='reroute'){event('model/rerouted',{toModel:'other'});return;}
 if(mode==='artifact'){event('rawResponseItem/completed',{item:{type:'reasoning',encrypted_content:'opaque-native-artifact'}});event('account/rateLimits/updated',{private:'never archive'});done();return;}
 out({id:901,method:'item/tool/call',params:{threadId:tid,turnId:turn,callId:'c1',tool:'web_search',arguments:{query:'historical'},namespace:mode==='wrongnamespace'?'other':'raven'}});
}
else if(x.method==='turn/steer')out({id:x.id,result:{turnId:turn}});
else if(x.id===901){
 const text=x.result.contentItems[0].text;
 if(mode!=='missingreceipt')event('rawResponseItem/completed',{item:{type:'function_call_output',call_id:'c1',output:[{type:'input_text',text:mode==='clipped'?text.slice(0,8):text}]}});
 event('item/completed',{item:{type:'reasoning',summary:['Returned summary'],content:[]}});done();
}
});`;
  const path=join(dir,"fake.cjs");writeFileSync(path,code);
  const launcher:AstraLauncher=()=>{launches++;return {command:process.execPath,args:[path],env:process.env,cwd:dir,cleanup:()=>{}};};
  return {client:new AstraSubscriptionClient(model==="gpt-5.6-sol"?{...runtime,account:"personal",account_identity_sha256:"fixture"}:runtime,launcher,{model,account:model==="gpt-5.6-sol"?"personal":"team"}),cleanup:()=>rmSync(dir,{recursive:true,force:true}),launches:()=>launches};
}
test("Native Codex admits reviewed custom arms and rejects unsupported model/account combinations",()=>{
  const args=["--profile","custom","--questions-file","questions.jsonl","--grading-file","grading.jsonl","--llm","codex:gpt-6-astra","--settings","none,frozen","--conc","4"];
  assert.equal(formalArguments(args,PKG_ROOT).selected.llm,"codex:gpt-6-astra");
  for(const arm of ['web','both','none,web'])assert.throws(()=>formalArguments(args.map(x=>x==='none,frozen'?arm:x),PKG_ROOT));
  assert.throws(()=>formalArguments([...args,'--effort','ultra'],PKG_ROOT));
  assert.throws(()=>formalArguments(args.map(x=>x==='codex:gpt-6-astra'?'codex-personal:gpt-6-astra':x),PKG_ROOT));
  for(const arm of ['web-filter','none,web-filter']) {
    const web=[...args.map(x=>x==='none,frozen'?arm:x),'--leak-llm','deepseek:deepseek-flash'];
    assert.equal(formalArguments(web,PKG_ROOT).selected.settings,arm);
    assert.throws(()=>formalArguments([...web,'--leak-filter','0'],PKG_ROOT));
  }
  assert.deepEqual(astraReasoning().api_parameters,{});
  assert.equal(astraReasoning().source,'provider-default');
  assert.equal(astraReasoning('high').thinking_effort,'high');
  assert.throws(()=>astraReasoning('ultra'));
  assert.deepEqual(astraTools([tool])[0]?.inputSchema,tool.parameters);
  assert.throws(()=>astraTools([{...tool,name:'shell'}]));
  for(const arg of ['web_search="disabled"','shell_tool','multi_agent','skip_host_skill_discovery'])assert.ok(astraArguments(true).includes(arg));
  assert.ok(astraArguments(false).includes('code_mode_host'));
});
test("native tool requests return to FABench and results resume the same isolated session",async()=>{
  const f=fake();const s=f.client.openForecast();const events:any[]=[];const onTrace=(x:any)=>events.push(x);
  const messages=initial();
  try{
    const a=await s.complete({prompt:'',messages,tools:[tool],onTrace});
    assert.equal(a.toolCalls?.[0]?.name,'web_search');assert.equal(a.finishReason,'tool_calls');
    messages.push({role:'assistant',content:a.text,toolCalls:a.toolCalls,reasoning:a.reasoning},
      {role:'tool',content:'VERBATIM RESULT',toolCallId:'c1'},
      {role:'user',content:'You have used your research budget. Do not search again.'});
    const b=await s.complete({prompt:'',messages,onTrace});
    assert.equal(b.finishReason,'stop');assert.equal(b.inputTokens,20);assert.equal(b.reasoning,'Returned summary');
    assert.equal(b.provider?.model,'gpt-6-astra');assert.equal(f.launches(),1);
    assert.ok(events.some(e=>e.type==='codex_astra_session'));
  }finally{s.close();f.cleanup();}
});
test("closed book and concurrent forecasts have independent native contexts",async()=>{
  const f=fake('none');
  try{const out=await Promise.all([1,2].map(()=>f.client.complete({prompt:'',messages:initial()})));
    assert.equal(out.length,2);assert.equal(f.launches(),2);assert.ok(out.every(x=>!x.toolCalls));
  }finally{f.cleanup();}
});
test("foreign history, unmatched results and native tool escapes fail without retry",async()=>{
  for(const mode of ['history','unmatched','forbidden','failure','compact','reroute']){
    const f=fake(['forbidden','failure','compact','reroute'].includes(mode)?mode:'tool');const s=f.client.openForecast();const events:any[]=[];
    try{
      const messages=initial();const request={prompt:'',messages,tools:[tool],onTrace:(e:any)=>events.push(e)};
      if(['forbidden','failure','compact','reroute'].includes(mode))await assert.rejects(s.complete(request));
      else {const a=await s.complete(request);messages.push({role:'assistant',content:'',toolCalls:a.toolCalls},{role:'tool',content:'VERBATIM RESULT',toolCallId:mode==='unmatched'?'other':'c1'});
        if(mode==='history')messages[1]!.content='different question';
        await assert.rejects(s.complete(request));}
      assert.equal(f.launches(),1);assert.ok(events.some(e=>e.type==='codex_astra_failed'));
      if(mode==='failure')assert.ok(events.some(e=>e.data?.method==='item/reasoning/textDelta'));
    }finally{s.close();f.cleanup();}
  }
});

test("predictor closes native sessions even when answer parsing fails",async()=>{
  const {AgenticSearchPredictor}=await import('../predictors/agentic-search.js');
  const {BudgetTier,NullRetrievalEnv}=await import('../predictors/types.js');
  let opened=0,closed=0;
  const client={id:'fake:session',async complete(){throw new Error('root client must not generate');},
    openForecast(){opened++;return {id:'fake:session',close(){closed++;},async complete(){return {text:'invalid answer',inputTokens:0,outputTokens:0,costUsd:0};}};}};
  const q={question_id:'synthetic',question_text:'fixture',resolution_criteria:'fixture',resolution_date:'2026-08-01T00:00:00Z',as_of_date:'2026-07-01T00:00:00Z',prediction_cutoff_utc:'2026-08-01T00:00:00Z',response_format:'raven.forecast.v2.1' as const,numeric_target_unit:null,forecast_prompt:'fixture',ground_truth:null,market_price_at_freeze:null,category:'test',difficulty_level:'easy',source:'synthetic',language:'en'};
  await assert.rejects(new AgenticSearchPredictor(client,undefined).predict(q,NullRetrievalEnv,BudgetTier.Unlimited));
  assert.equal(opened,1);assert.equal(closed,1);
});

test("opaque native reasoning is retained as artifact-only, account events are excluded",async()=>{
  const f=fake('artifact');const events:any[]=[];
  try{const out=await f.client.complete({prompt:'',messages:initial(),onTrace:e=>events.push(e)});
    assert.equal(out.reasoningCapture?.status,'artifact_only');
    assert.ok(events.some(e=>e.data?.method==='rawResponseItem/completed'));
    assert.ok(!JSON.stringify(events).includes('never archive'));
    assert.deepEqual(f.client.reasoningConfiguration().api_parameters.harness_runtime,runtime);
  }finally{f.cleanup();}
});

test("Sol personal transport pins high effort and resumes FABench retrieval without changing model/account",async()=>{
  const f=fake("tool","gpt-5.6-sol");const s=f.client.openForecast();
  try{
    assert.equal(f.client.id,"codex-personal:gpt-5.6-sol");
    assert.equal(f.client.traceMetadata.credential_resource,"personal-chatgpt:fixture");
    assert.throws(()=>f.client.reasoningConfiguration());
    const messages=initial();
    const first=await s.complete({prompt:"",messages,tools:[tool],effort:"high"});
    assert.equal(first.provider?.model,"gpt-5.6-sol");
    messages.push({role:"assistant",content:"",toolCalls:first.toolCalls},
      {role:"tool",content:"VERBATIM RESULT",toolCallId:"c1"});
    const result=await s.complete({prompt:"",messages,effort:"high"});
    assert.equal(result.finishReason,"stop");assert.equal(result.provider?.model,"gpt-5.6-sol");
    assert.equal(f.launches(),1);
  }finally{s.close();f.cleanup();}
});
test("Sol admission allows July custom none/frozen/web-filter but requires high and filtered tools",()=>{
  const base=["--profile","custom","--questions-file","questions.jsonl","--grading-file","grading.jsonl",
    "--llm","codex-personal:gpt-5.6-sol","--conc","4","--effort","high"];
  for(const arm of ["none","frozen","web-filter"]){
    const args=[...base,"--settings",arm,...(arm==="web-filter"?["--leak-llm","deepseek:deepseek-flash"]:[])];
    assert.equal(formalArguments(args,PKG_ROOT).selected.settings,arm);
    assert.throws(()=>formalArguments(args.filter(x=>!["--effort","high"].includes(x)),PKG_ROOT));
    assert.throws(()=>formalArguments([...args,"--ledger","1"],PKG_ROOT));
  }
  assert.throws(()=>formalArguments([...base,"--settings","web-filter"],PKG_ROOT));
  assert.throws(()=>formalArguments([...base,"--settings","web"],PKG_ROOT));
});
test("Sol rejects wrong model, missing high effort and mismatched account before spawning",async()=>{
  const f=fake("none","gpt-5.6-sol");
  try{
    await assert.rejects(f.client.complete({prompt:"",messages:initial()}));
    await assert.rejects(f.client.complete({prompt:"",messages:initial(),effort:"high",model:"gpt-6-astra"}));
    assert.equal(f.launches(),0);
    assert.throws(()=>new AstraSubscriptionClient(runtime,undefined,{model:"gpt-5.6-sol",account:"personal"}));
  }finally{f.cleanup();}
});

test("GPT-6 Sol uses the native team account with explicit high effort", async () => {
  const f=fake('none','gpt-6-sol');
  try {
    assert.equal(f.client.id,'codex:gpt-6-sol');
    assert.throws(()=>f.client.reasoningConfiguration(),/high effort/);
    assert.equal(f.client.reasoningConfiguration('high').thinking_effort,'high');
    const result=await f.client.complete({prompt:'',messages:initial(),effort:'high'});
    assert.equal(result.provider?.model,'gpt-6-sol');
    assert.equal(f.launches(),1);
    const args=['--profile','custom','--questions-file','questions.jsonl','--grading-file','grading.jsonl',
      '--llm','codex:gpt-6-sol','--settings','none,frozen','--conc','6','--effort','high'];
    assert.equal(formalArguments(args,PKG_ROOT).selected.llm,'codex:gpt-6-sol');
    assert.throws(()=>formalArguments(args.filter(x=>!['--effort','high'].includes(x)),PKG_ROOT));
    assert.throws(()=>formalArguments(args.map(x=>x==='codex:gpt-6-sol'?'codex-personal:gpt-6-sol':x),PKG_ROOT));
  } finally {f.cleanup();}
});

for(const mode of ['clipped','missingreceipt','wrongnamespace'])test('direct tool delivery rejects '+mode,async()=>{
 const f=fake(mode),session=f.client.openForecast();const messages=initial();
 try {
  const run=async()=>{const first=await session.complete({prompt:'',messages,tools:[tool]});
   messages.push({role:'assistant',content:'',toolCalls:first.toolCalls},{role:'tool',content:'完整 original '+ 'x'.repeat(60000),toolCallId:'c1'});
   await session.complete({prompt:'',messages});};
  await assert.rejects(run(),/delivery|namespace|Unauthorized|receipts/);
 }finally{session.close();f.cleanup();}
});
test('long direct pages arrive intact beyond old exec cap and emit a final receipt',async()=>{
 const f=fake(),session=f.client.openForecast(),messages=initial(),events:any[]=[];
 try{
  const first=await session.complete({prompt:'',messages,tools:[tool]});
  const body=('原文🙂\\n'+ 'a'.repeat(100)).repeat(1000);
  messages.push({role:'assistant',content:'',toolCalls:first.toolCalls},{role:'tool',content:body,toolCallId:'c1'});
  await session.complete({prompt:'',messages,onTrace:e=>events.push(e)});
  const receipt=events.find(e=>e.type==='codex_tool_delivery');
  assert.equal(receipt.data.complete,true);assert.equal(receipt.data.actual_chars,body.length);
  assert.ok(astraArguments(true).some(x=>x.includes('direct_only_tool_namespaces')));
 }finally{session.close();f.cleanup();}
});
