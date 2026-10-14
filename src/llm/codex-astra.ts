/** Astra subscription transport. One native session per question; FABench executes retrieval. */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { LlmClient, LlmCompletion, LlmRequest, LlmMessage, ReasoningConfiguration, ToolSpec } from "./benchmark-client.js";
import { CODEX_FEATURES_OFF, CODEX_MODEL, inspectCodexSubscription, inspectPersonalCodexAuth, personalCodexHome, type CodexAccount } from "./codex-subscription.js";
import { ProviderApiError } from "./openai-compatible.js";
import { sha256 } from "../tracing/trace-archive.js";

export const ASTRA_MODEL = "gpt-6-astra";
export const SOL6_MODEL = "gpt-6-sol";
type NativeModel = typeof ASTRA_MODEL | typeof CODEX_MODEL | typeof SOL6_MODEL;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Namespace of the dynamic tools; the model sees it, so the value stays "raven". */
export const TOOL_NAMESPACE = "raven";
export const CODEX_DELIVERY_POLICY = "raven-direct-paged-tools-v2";
// Keep FABench results out of exec/wait's independent, model-selected output caps.
const FEATURES_OFF = CODEX_FEATURES_OFF.filter(x => x !== "code_mode" && x !== "code_mode_host");
type Runtime = ReturnType<typeof inspectCodexSubscription> & { code_mode_host_sha256?:string };
function inspectAstraRuntime(account:CodexAccount="team"):Runtime {
  const runtime=inspectCodexSubscription(account);
  const entry=realpathSync("/usr/bin/codex");
  const pkg=createRequire(entry).resolve("@openai/codex-linux-x64/package.json");
  return {...runtime,code_mode_host_sha256:sha256(readFileSync(join(dirname(pkg),"vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host")))};
}
type Launch = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; cleanup(): void };
export type AstraLauncher = (tools: boolean) => Launch;

export function astraArguments(tools: boolean): string[] {
  return ["app-server", "--stdio", "--strict-config",
    ...["forced_login_method=\"chatgpt\"", "cli_auth_credentials_store=\"file\"", "model_provider=\"openai\"",
      "web_search=\"disabled\"", "project_doc_max_bytes=0", "approval_policy=\"never\"",
      "history.persistence=\"none\"", "suppress_unstable_features_warning=true",
      // Never silently replace full evidence/history with a compaction summary.
      "model_auto_compact_token_limit=10000000", "tool_output_token_limit=10000000"].flatMap(value => ["-c", value]),
    ...FEATURES_OFF.flatMap(name => ["--disable", name]),
    ...(tools ? ["-c", 'features.code_mode={enabled=true,direct_only_tool_namespaces=["raven"]}', "--enable", "code_mode_host"] : ["--disable", "code_mode", "--disable", "code_mode_host"]),
    "--enable", "skip_host_skill_discovery"];
}
function isolatedLaunch(tools: boolean, account:CodexAccount="team", expectedIdentity?:string): Launch {
  // The wrapper synchronizes shared rotations. Only credentials enter the isolated home;
  // user config, MCP servers, skills, hooks, memories and repository files never enter it.
  if(account==="team") execFileSync("gpt-raven", ["--version"], {timeout:15_000, stdio:"ignore"});
  else if(inspectPersonalCodexAuth()!==expectedIdentity) throw new Error("Personal Codex account changed after admission");
  const root=mkdtempSync(join(tmpdir(),"raven-astra-")); chmodSync(root,0o700);
  try {
    const home=join(root,"home"), cwd=join(root,"empty"); mkdirSync(home,{mode:0o700}); mkdirSync(cwd,{mode:0o700});
    const auth=account==="personal" ? join(personalCodexHome(),"auth.json") : join(userInfo().homedir,".codex-gpt-raven/auth.json");
    const originalAuth=readFileSync(auth,"utf8");
    const saved=JSON.parse(originalAuth);
    if(saved.auth_mode!=="chatgpt" || saved.OPENAI_API_KEY || !saved.tokens?.access_token)
      throw new Error("Native Codex requires ChatGPT authentication; API fallback is forbidden");
    copyFileSync(auth,join(home,"auth.json")); chmodSync(join(home,"auth.json"),0o600);
    // Environment secrets are unnecessary: native networking is only Codex authentication.
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH, HOME:userInfo().homedir, CODEX_HOME:home,
      LANG:process.env.LANG??"C.UTF-8", TMPDIR:tmpdir()};
    return {command:"/usr/bin/codex",args:astraArguments(tools),env,cwd,cleanup:()=>{
      // Preserve refreshes only if no other process/admin has replaced the source.
      // Never overwrite a newly rotated account, and never put credentials in traces.
      try {
        const refreshed=readFileSync(join(home,"auth.json"),"utf8");
        if(refreshed!==originalAuth && readFileSync(auth,"utf8")===originalAuth) {
          const next=JSON.parse(refreshed);
          if(next.auth_mode==="chatgpt" && next.tokens?.account_id===saved.tokens.account_id) {
            const path=join(dirname(auth),`.auth-astra-${process.pid}-${root.split("/").at(-1)}`);
            writeFileSync(path,refreshed,{mode:0o600});renameSync(path,auth);
          }
        }
      } catch { /* Cleanup cannot change an already archived model result. */ }
      finally {rmSync(root,{recursive:true,force:true});}
    }};
  } catch(error) {rmSync(root,{recursive:true,force:true});throw error;}
}
export function astraTools(tools:ToolSpec[] = []) {
  if(new Set(tools.map(t=>t.name)).size!==tools.length || tools.some(t=>!["web_search","web_fetch"].includes(t.name)))
    throw new Error("Astra may expose only FABench web_search and web_fetch");
  return tools.map(t=>({type:"function",name:t.name,description:t.description,inputSchema:t.parameters,deferLoading:false}));
}
/** Raw response tool outputs are the final client-visible boundary, not the bridge receipt. */
export function nativeToolText(output:unknown):string {
  if(typeof output==="string")return output;
  if(Array.isArray(output))return output.map(x=>
    x && ["input_text","inputText","text"].includes(x.type) && typeof x.text==="string" ? x.text : "").join("\n");
  return "";
}
export function astraReasoning(effort?:string):ReasoningConfiguration {
  if(effort!==undefined && !EFFORTS.includes(effort)) throw new Error("Unsupported Astra reasoning effort");
  return {reasoning_mode:effort?"reasoning":null,thinking_effort:effort??null,requested_thinking_effort:effort??null,
    source:effort?"explicit":"provider-default",api_parameters:effort?{effort}:{},
    history_replay:{policy:"codex-native-per-question-session",field:"native session; no cross-question history"}};
}
export class AstraSubscriptionClient implements LlmClient {
  readonly id:string;
  private readonly runtime:Runtime;
  private readonly launcher:AstraLauncher;
  readonly traceMetadata:Readonly<Record<string,unknown>>;
  constructor(runtime?:Runtime, launcher?:AstraLauncher,
      private readonly options:{model?:NativeModel;account?:CodexAccount}={}) {
    const model=options.model??ASTRA_MODEL, account=options.account??"team";
    if(model!==ASTRA_MODEL && model!==CODEX_MODEL && model!==SOL6_MODEL) throw new Error("Unsupported native Codex model");
    if(account==="personal" && model!==CODEX_MODEL) throw new Error("Personal native account supports GPT-5.6 Sol only");
    this.runtime=runtime??inspectAstraRuntime(account);
    if((this.runtime.account==="personal")!==(account==="personal")) throw new Error("Native Codex runtime/account mismatch");
    this.launcher=launcher??(tools=>isolatedLaunch(tools,account,this.runtime.account_identity_sha256));
    this.id=(account==="personal"?"codex-personal":"codex")+":"+model;
    this.traceMetadata={harness:"codex-app-server-raven-v2",delivery_policy:CODEX_DELIVERY_POLICY,model,runtime:this.runtime,
      base_url:account==="personal"?"chatgpt-subscription-via-personal-codex":"chatgpt-subscription-via-gpt-raven",
      credential_resource:account==="personal"?"personal-chatgpt:"+this.runtime.account_identity_sha256:"gpt-raven-chatgpt-subscription",
      pricing:{known:false,usd_cost_known:false,billing:"chatgpt_subscription"},
      isolation:{fresh_context:true,ephemeral:true,isolated_config:true,environments:[],web_search:"disabled",
        disabled_features:FEATURES_OFF,question_prompt:"verbatim",system_prompt:"baseInstructions replacement",
        tools:"Direct raven namespace; saved original text with optional paged reads; no exec/wait wrapping",tool_budget:"Raven execution cap; native definitions remain visible after exhaustion",
        compaction:"disabled; context overflow fails the cell",codex_environment_messages:"Native harness metadata may differ from the API experiment"},
      reasoning_visibility:"Archive returned native reasoning events; empty/encrypted output is not full visible CoT"};
  }
  reasoningConfiguration(effort?:string):ReasoningConfiguration {
    if((this.options.model===CODEX_MODEL || this.options.model===SOL6_MODEL) && effort!=="high") throw new Error("Sol requires explicit high effort");
    const config=astraReasoning(effort);
    return {...config,api_parameters:{...config.api_parameters,harness_runtime:this.runtime,isolation:this.traceMetadata.isolation}};
  }
  openForecast():AstraForecast {return new AstraForecast(this.traceMetadata,this.launcher,this.id,(this.options.model??ASTRA_MODEL));}
  async complete(req:LlmRequest):Promise<LlmCompletion> {
    const session=this.openForecast();try{return await session.complete(req);}finally{session.close();}
  }
}

type PendingRpc={method:string;resolve:(x:any)=>void;reject:(e:Error)=>void};
/** A suspended dynamic request is returned to the existing predictor as an ordinary tool call. */
export class AstraForecast implements LlmClient {
  private child?:ChildProcessWithoutNullStreams;
  private launch?:Launch;
  private rpcId=0;
  private rpcPending=new Map<number,PendingRpc>();
  private pendingTools=new Map<string,string|number>();
  private deliveredTools=new Set<string>();
  private queue:LlmCompletion[]=[];
  private waiter?:{resolve:(x:LlmCompletion)=>void;reject:(e:Error)=>void};
  private failed?:Error;
  private closed=false;
  private done=false;
  private busy=false;
  private threadId?:string;
  private turnId?:string;
  private effort?:string;
  private toolNames=new Set<string>();
  private seen:LlmMessage[]=[];
  private trace?:LlmRequest["onTrace"];
  private finalText="";
  private reasoning:string[]=[];
  private nativeReasoning=0;
  private reasoningArtifact=false;
  private total={inputTokens:0,outputTokens:0,cachedInputTokens:0,reasoningOutputTokens:0};
  private reported={...this.total};
  private timer?:ReturnType<typeof setTimeout>;
  private stderr="";
  private expectedToolOutputs=new Map<string,string>();
  private interrupt=()=>this.fail(new Error("Astra forecast interrupted"));
  constructor(readonly traceMetadata:Readonly<Record<string,unknown>>,private launcher:AstraLauncher,
    readonly id:string="codex:"+ASTRA_MODEL, private readonly model:NativeModel=ASTRA_MODEL) {}
  reasoningConfiguration=astraReasoning;
  private send(value:unknown) {this.child!.stdin.write(JSON.stringify(value)+"\n");}
  private rpc(method:string,params:unknown):Promise<any> {
    if(this.failed || this.closed)return Promise.reject(this.failed??new Error("Closed Astra session"));
    const id=++this.rpcId;
    return new Promise((resolve,reject)=>{this.rpcPending.set(id,{method,resolve,reject});this.send({id,method,params});});
  }
  private fail(error:Error) {
    if(this.failed || this.closed)return;
    this.failed=error;
    this.trace?.({type:"codex_astra_failed",data:{message:error.message,stream_complete:false,reasoning_items:this.nativeReasoning}});
    this.waiter?.reject(error);this.waiter=undefined;
    for(const pending of this.rpcPending.values())pending.reject(error);this.rpcPending.clear();
    this.close();
  }
  close() {
    if(this.closed)return;this.closed=true;
    clearTimeout(this.timer);process.removeListener("SIGTERM",this.interrupt);process.removeListener("SIGINT",this.interrupt);
    if(this.child) {
      const child=this.child;const cleanup=this.launch?.cleanup;
      child.once("close",()=>cleanup?.());
      try{process.kill(-child.pid!,"SIGTERM");}catch{child.kill("SIGTERM");}
      const kill=setTimeout(()=>{try{process.kill(-child.pid!,"SIGKILL");}catch{}},2000);kill.unref();
      child.once("close",()=>clearTimeout(kill));
    } else this.launch?.cleanup();
  }
  private finishPart(tool?:{id:string;name:string;args:Record<string,unknown>}) {
    const reasoning=this.reasoning.join("\n\n");this.reasoning=[];
    const part:LlmCompletion={text:tool?"":this.finalText,reasoning,costUsd:0,
      inputTokens:Math.max(0,this.total.inputTokens-this.reported.inputTokens),
      outputTokens:Math.max(0,this.total.outputTokens-this.reported.outputTokens),
      cachedInputTokens:Math.max(0,this.total.cachedInputTokens-this.reported.cachedInputTokens),
      reasoningTokens:Math.max(0,this.total.reasoningOutputTokens-this.reported.reasoningOutputTokens),
      provider:{responseId:this.threadId,model:this.model},finishReason:tool?"tool_calls":"stop",
      ...(tool?{toolCalls:[tool]}:{}),
      reasoningCapture:{policy:"raven.provider-reasoning.v1",status:reasoning?"text_returned":this.reasoningArtifact?"artifact_only":this.nativeReasoning?"empty":"not_returned",
        native_fields:this.nativeReasoning?["codex.item.reasoning", "codex.rawResponseItem.reasoning"]:[],native_frames:this.nativeReasoning,
        native_trace_enabled:!!this.trace,readable_source:reasoning?"codex native reasoning (may be summary)":null,
        readable_chars:reasoning.length,readable_sha256:sha256(reasoning),stream_complete:!tool}};
    this.reported={...this.total};this.nativeReasoning=0;this.reasoningArtifact=false;
    if(this.waiter){const w=this.waiter;this.waiter=undefined;w.resolve(part);}else this.queue.push(part);
  }
  private event(value:any) {
    if(this.closed)return;
    // Do not archive account/login notifications, auth files, or configuration containing secrets.
    if(value.id!==undefined && !value.method) {
      const p=this.rpcPending.get(value.id);if(!p)return;this.rpcPending.delete(value.id);
      if(value.error)p.reject(new Error(`Codex RPC: ${JSON.stringify(value.error)}`));
      else {
        // Responses and notifications can arrive in the same stdout chunk, before an
        // awaiting start() continuation gets a microtask. Bind IDs synchronously.
        if(p.method==="thread/start")this.threadId=value.result.thread.id;
        if(p.method==="turn/start")this.turnId=value.result.turn.id;
        p.resolve(value.result);
      }
      return;
    }
    const method=value.method as string, p=value.params??{};
    if(method?.startsWith("account/") || method==="attestation/generate") {
      if(value.id!==undefined)throw new Error("Unexpected authentication/attestation request");return;
    }
    if(method?.startsWith("item/") || method?.startsWith("turn/") || method==="thread/tokenUsage/updated" || method==="error" || method?.startsWith("rawResponse") ||
      method==="model/rerouted" || method==="thread/compacted")
      this.trace?.({type:"codex_astra_event",data:value});
    if(value.id!==undefined) {
      if(method!=="item/tool/call" || p.threadId!==this.threadId || p.turnId!==this.turnId || p.namespace!==TOOL_NAMESPACE ||
        !this.toolNames.has(p.tool) || typeof p.callId!=="string" || this.pendingTools.has(p.callId))
        throw new Error(`Unauthorized native tool request: ${method}/${p.tool??""}`);
      if(!p.arguments || typeof p.arguments!=="object" || Array.isArray(p.arguments))throw new Error("Invalid native tool arguments");
      this.pendingTools.set(p.callId,value.id);
      this.finishPart({id:p.callId,name:p.tool,args:p.arguments});return;
    }
    if(method==="model/rerouted" || method==="thread/compacted")
      throw new Error(`Native model/history changed: ${method}`);
    if(method==="rawResponseItem/completed" && p.item?.type==="reasoning") {
      this.nativeReasoning++;
      this.reasoningArtifact ||= Boolean(p.item.encrypted_content);
    }
    if(method==="rawResponseItem/completed" && p.item?.type==="function_call_output") {
      const id=p.item.call_id, expected=this.expectedToolOutputs.get(id);
      if(expected!==undefined) {
        const actual=nativeToolText(p.item.output);
        this.trace?.({type:"codex_tool_delivery",data:{policy:CODEX_DELIVERY_POLICY,call_id:id,
          expected_chars:expected.length,actual_chars:actual.length,expected_sha256:sha256(expected),
          actual_sha256:sha256(actual),complete:actual===expected}});
        if(actual!==expected)throw new Error("Codex tool delivery mismatch: requested page was shortened or changed");
        this.expectedToolOutputs.delete(id);
      }
    }
    if(method==="error")throw new Error(`Codex turn error: ${JSON.stringify(p.error)}`);
    if(method==="thread/tokenUsage/updated")this.total={...p.tokenUsage.total};
    if(method==="item/started" || method==="item/completed") {
      const item=p.item;
      if(!["userMessage","agentMessage","reasoning","dynamicToolCall"].includes(item?.type))
        throw new Error(`Unauthorized native activity: ${item?.type}`);
      if(item.type==="dynamicToolCall" && (!this.toolNames.has(item.tool)||item.namespace!==TOOL_NAMESPACE))
        throw new Error(`Unauthorized native function: ${item.tool}`);
      if(method==="item/completed" && item.type==="agentMessage")this.finalText=item.text??"";
      if(method==="item/completed" && item.type==="reasoning") {
        this.nativeReasoning++;
        this.reasoning.push(...(item.content??[]),...(item.summary??[]));
      }
    }
    if(method==="turn/started")this.turnId=p.turn.id;
    if(method==="turn/completed") {
      if(p.turn.status!=="completed" || p.turn.error)throw new Error(`Codex turn ${p.turn.status}: ${JSON.stringify(p.turn.error)}`);
      if(this.pendingTools.size)throw new Error("Turn ended with unanswered tool requests");
      if(this.expectedToolOutputs.size)throw new Error("Turn ended without final native tool delivery receipts");
      this.done=true;this.finishPart();
    }
  }
  private async start(req:LlmRequest,messages:LlmMessage[]) {
    if(messages.length!==2 || messages[0]?.role!=="system" || messages[1]?.role!=="user")
      throw new Error("Astra needs one fresh system/user forecast");
    if(!messages[0].content.startsWith("Follow the historical information boundary and JSON response contract in the question."))
      throw new Error("Astra requires the reviewed structured forecast system");
    const tools=astraTools(req.tools);this.toolNames=new Set(tools.map(t=>t.name));this.effort=req.effort;
    this.launch=this.launcher(tools.length>0);
    this.child=spawn(this.launch.command,this.launch.args,{cwd:this.launch.cwd,env:this.launch.env,stdio:"pipe",detached:true});
    this.timer=setTimeout(()=>this.fail(new Error("Astra forecast exceeded 30 minute limit")),1800000);
    process.once("SIGTERM",this.interrupt);process.once("SIGINT",this.interrupt);
    let buffer="";
    this.child.stdout.setEncoding("utf8");this.child.stderr.setEncoding("utf8");
    this.child.stdin.on("error",e=>this.fail(e));
    this.child.stdout.on("data",(data:string)=>{buffer+=data;let i;while((i=buffer.indexOf("\n"))>=0){
      const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;
      try{this.event(JSON.parse(line));}catch(e){this.fail(e instanceof Error?e:new Error(String(e)));}
    }});
    this.child.stderr.on("data",(data:string)=>{this.stderr=(this.stderr+data).slice(-8000);});
    this.child.on("error",e=>this.fail(e));
    this.child.on("close",code=>{if(!this.closed)this.fail(new Error(`Codex app-server exited ${code}: ${this.stderr}`));});
    await this.rpc("initialize",{clientInfo:{name:"raven_bench",version:"1"},capabilities:{experimentalApi:true}});
    this.send({method:"initialized"});
    const started=await this.rpc("thread/start",{model:this.model,modelProvider:"openai",ephemeral:true,experimentalRawEvents:true,
      baseInstructions:messages[0].content,developerInstructions:"",cwd:this.launch.cwd,environments:[],
      approvalPolicy:"never",sandbox:"read-only",allowProviderModelFallback:false,
      dynamicTools:tools.length?[{type:"namespace",name:TOOL_NAMESPACE,
        description:"Raven historical evidence tools. Results include original-text pages and continuation references.",tools}]:[]});
    if(started.model!==this.model || started.modelProvider!=="openai" || started.instructionSources?.length || started.thread.environments?.length)
      throw new Error("Astra native runtime model or instruction isolation mismatch");
    this.threadId=started.thread.id;
    this.trace?.({type:"codex_astra_session",data:{thread_id:this.threadId,model:started.model,
      default_effort:started.reasoningEffort,requested_effort:req.effort??null,
      system_sha256:sha256(messages[0].content),prompt_sha256:sha256(messages[1].content),dynamic_tools:tools,
      instruction_sources:started.instructionSources,environments:started.thread.environments}});
    const turn=await this.rpc("turn/start",{threadId:this.threadId,input:[{type:"text",text:messages[1].content}],
      ...(req.effort?{effort:req.effort}:{})});this.turnId=turn.turn.id;
  }
  async complete(req:LlmRequest):Promise<LlmCompletion> {
    if(this.busy)throw new Error("Concurrent calls on one Astra forecast are forbidden");this.busy=true;this.trace=req.onTrace;
    try {
      if((this.model===CODEX_MODEL || this.model===SOL6_MODEL) && req.effort!=="high") throw new Error("Sol requires explicit high effort");
      astraReasoning(req.effort);
      if(req.model && req.model!==this.model)throw new Error("Astra model override is forbidden");
      if(this.failed || this.closed || this.done)throw this.failed??new Error("Astra forecast is closed");
      const messages=req.messages??[{role:"system" as const,content:req.system??""},{role:"user" as const,content:req.prompt}];
      if(!this.child)await this.start(req,messages);
      else {
        if(req.effort!==this.effort || JSON.stringify(messages.slice(0,this.seen.length))!==JSON.stringify(this.seen))
          throw new Error("Astra forecast history or effort changed");
        astraTools(req.tools);
        const appended=messages.slice(this.seen.length);
        const results=appended.filter(m=>m.role==="tool");
        if(results.length!==this.deliveredTools.size || results.some(m=>!m.toolCallId||!this.deliveredTools.has(m.toolCallId)) ||
          new Set(results.map(m=>m.toolCallId)).size!==results.length || appended.some(m=>m.role==="system"))
          throw new Error("Astra continuation tool results do not match delivered calls");
        const notices=appended.filter(m=>m.role==="user");
        if(notices.length)await this.rpc("turn/steer",{threadId:this.threadId,expectedTurnId:this.turnId,
          input:notices.map(m=>({type:"text",text:m.content}))});
        for(const result of results) {
          const id=this.pendingTools.get(result.toolCallId!)!;this.pendingTools.delete(result.toolCallId!);
          this.expectedToolOutputs.set(result.toolCallId!,result.content);
          this.send({id,result:{contentItems:[{type:"inputText",text:result.content}],success:true}});
        }
        this.deliveredTools.clear();
      }
      this.seen=structuredClone(messages);
      if(this.failed)throw this.failed;
      const next=this.queue.shift()??await new Promise<LlmCompletion>((resolve,reject)=>{
        if(this.failed)reject(this.failed);else this.waiter={resolve,reject};
      });
      for(const call of next.toolCalls??[])this.deliveredTools.add(call.id);
      return next;
    } catch(error) {
      this.fail(error instanceof Error?error:new Error(String(error)));
      throw new ProviderApiError(this.id,400,"http_error",false,"codex_no_automatic_retry",String(error));
    } finally {this.busy=false;}
  }
}
