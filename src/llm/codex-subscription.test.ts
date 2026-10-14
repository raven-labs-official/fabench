import assert from "node:assert/strict";
import test from "node:test";
import {CODEX_NONE_SYSTEM, codexInput, codexArguments, inspectCodexEvent, CodexSubscriptionClient, inspectPersonalCodexAuth, personalCodexEnvironment} from "./codex-subscription.js";
import {formalArguments} from "../experiments/environment-check.js";
import {formalQuestionIds,needsFormalSet} from "../datasets/test-fixtures.js";
import {PKG_ROOT} from "../paths.js";
import {mkdtempSync,writeFileSync,rmSync,chmodSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const request={system:CODEX_NONE_SYSTEM,prompt:"Question bytes\nremain unchanged",effort:"high"};
test("subscription requests keep exact prompts and reject tools/history/model or effort changes",()=>{
  assert.deepEqual(codexInput(request),{system:request.system,prompt:request.prompt});
  for(const patch of [{system:"changed"},{effort:"low"},{model:"gpt-6-astra"},
    {tools:[{name:"web_search",description:"search",parameters:{}}]},
    {messages:[{role:"system",content:CODEX_NONE_SYSTEM},{role:"user",content:"q"},{role:"assistant",content:"history"}]}])
    assert.throws(()=>codexInput({...request,...patch} as any));
  const args=codexArguments("/isolated/system.txt","/isolated/empty","/isolated/answer.txt");
  for(const value of ["--ignore-user-config","--ignore-rules","--ephemeral","forced_login_method=\"chatgpt\"",
    "model_reasoning_effort=\"high\"","web_search=\"disabled\"","shell_tool","multi_agent","plugins"])
    assert.ok(args.includes(value),value);
  assert.equal(args.at(-1),"-");
  const client=new CodexSubscriptionClient({version:"test",executable_sha256:"test",entrypoint_sha256:"test",wrapper_sha256:"test",authentication:"chatgpt_subscription"});
  assert.equal(client.reasoningConfiguration("high").thinking_effort,"high");
  assert.throws(()=>client.reasoningConfiguration());
  assert.equal((client.traceMetadata.pricing as any).usd_cost_known,false);
});

test("tool activity, unknown item types and failed turns cannot yield a score",()=>{
  for(const type of ["web_search","command_execution","mcp_tool_call","file_change","todo_list","unknown"])
    assert.throws(()=>inspectCodexEvent({type:"item.started",item:{type}}));
  for(const type of ["reasoning","agent_message"]) inspectCodexEvent({type:"item.completed",item:{type}});
  assert.throws(()=>inspectCodexEvent({type:"turn.failed",error:{message:"limit"}}));
  inspectCodexEvent({type:"item.completed",item:{type:"error",message:"Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`."}});
  assert.throws(()=>inspectCodexEvent({type:"item.completed",item:{type:"error",message:"model unavailable"}}));
});

test("shared admission requires exact Sol model and high effort",{skip:needsFormalSet},()=>{
  const args=["--llm","codex:gpt-5.6-sol","--settings","none","--conc","2","--effort","high","--ids",formalQuestionIds()[0]!];
  assert.equal(formalArguments(args,PKG_ROOT).selected.llm,"codex:gpt-5.6-sol");
  for(const [before,after] of [["none","web"],["high","low"],["codex:gpt-5.6-sol","codex:unsupported-model"]])
    assert.throws(()=>formalArguments(args.map(x=>x===before?after!:x),PKG_ROOT));
});

test("CLI transport archives returned reasoning and requires a completed independent turn",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"codex-fake-")),oldPath=process.env.PATH;
  const executable=join(dir,"gpt-raven");
  writeFileSync(executable,`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);let input='';
process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
if(input!==${JSON.stringify(request.prompt)})process.exit(4);
const system=args.find(x=>x.startsWith('model_instructions_file='));
if(fs.readFileSync(JSON.parse(system.slice(system.indexOf('=')+1)),'utf8')!==${JSON.stringify(CODEX_NONE_SYSTEM)})process.exit(5);
for(const event of [{type:'thread.started',thread_id:'fake-thread'},{type:'item.completed',item:{type:'reasoning',text:'Returned summary'}},
{type:'item.completed',item:{type:'agent_message',text:'forecast'}},{type:'turn.completed',usage:{input_tokens:12,output_tokens:7}}])console.log(JSON.stringify(event));
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'forecast');});
`,{mode:0o700});
  process.env.PATH=dir+':'+oldPath;
  try {
    const events:any[]=[];
    const client=new CodexSubscriptionClient({version:"test",executable_sha256:"test",entrypoint_sha256:"test",wrapper_sha256:"test",authentication:"chatgpt_subscription"});
    const output=await client.complete({...request,onTrace:e=>events.push(e)});
    assert.equal(output.text,"forecast");assert.equal(output.reasoning,"Returned summary");
    assert.equal(output.inputTokens,12);assert.equal(output.outputTokens,7);
    assert.equal(output.reasoningCapture?.stream_complete,true);
    assert.equal(events.filter(e=>e.type==="codex_event").length,4);
    assert.equal(output.provider?.model,undefined,"CLI selection is recorded separately from unavailable provider model echo");
  } finally {process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});}
});


test("personal credentials stay owner-only, reject API fallback and identify account without token bytes",()=>{
  const home=mkdtempSync(join(tmpdir(),"codex-personal-test-"));
  const path=join(home,"auth.json");
  const auth={auth_mode:"chatgpt",OPENAI_API_KEY:null,tokens:{account_id:"personal-account",access_token:"secret-a",refresh_token:"secret-b"}};
  const save=(data:unknown)=>writeFileSync(path,JSON.stringify(data),{mode:0o600});
  try {
    save(auth);const id=inspectPersonalCodexAuth(home);assert.match(id,/^[a-f0-9]{64}$/);
    save({...auth,tokens:{...auth.tokens,access_token:"rotated",refresh_token:"rotated"}});
    assert.equal(inspectPersonalCodexAuth(home),id,"token refresh must not change the condition");
    save({...auth,tokens:{...auth.tokens,account_id:"other-account"}});
    assert.notEqual(inspectPersonalCodexAuth(home),id);
    save({...auth,OPENAI_API_KEY:"api-key"});assert.throws(()=>inspectPersonalCodexAuth(home),/API-key fallback/);
    save(auth);chmodSync(path,0o640);assert.throws(()=>inspectPersonalCodexAuth(home),/owner-only/);
    chmodSync(path,0o600);chmodSync(home,0o750);assert.throws(()=>inspectPersonalCodexAuth(home),/owner-only/);
    chmodSync(home,0o700);rmSync(path);symlinkSync(join(home,"missing"),path);
    assert.throws(()=>inspectPersonalCodexAuth(home),/owner-only/);
    const env=personalCodexEnvironment(home);assert.equal(env.CODEX_HOME,home);
    for(const key of ["OPENAI_API_KEY","OPENAI_BASE_URL","CODEX_API_KEY"]) assert.equal(env[key],undefined);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test("personal pilot has explicit identity and the same reviewed isolation; other arms and effort fail admission",async t=>{
  const runtime={version:"test",executable_sha256:"test",entrypoint_sha256:"test",wrapper_sha256:null,
    authentication:"chatgpt_subscription",account:"personal" as const,account_identity_sha256:"account-hash"};
  const personal=new CodexSubscriptionClient(runtime,"personal");
  const team=new CodexSubscriptionClient({...runtime,account:undefined,account_identity_sha256:undefined});
  assert.equal(personal.id,"codex-personal:gpt-5.6-sol");
  assert.notEqual(personal.traceMetadata.credential_resource,team.traceMetadata.credential_resource);
  assert.deepEqual(personal.traceMetadata.isolation,team.traceMetadata.isolation);
  assert.throws(()=>new CodexSubscriptionClient(runtime),/mismatch/);
  await t.test("admission under the default formal-232 preset",{skip:needsFormalSet},()=>{
    const args=["--llm",personal.id,"--settings","none","--conc","2","--effort","high","--ids",formalQuestionIds()[0]!];
    assert.equal(formalArguments(args,PKG_ROOT).selected.llm,personal.id);
    for(const [before,after] of [["none","web-filter"],["high","low"],[personal.id,"codex-personal:gpt-6-astra"]])
      assert.throws(()=>formalArguments(args.map(x=>x===before?after!:x),PKG_ROOT));
  });
});
