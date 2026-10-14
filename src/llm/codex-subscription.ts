/** ChatGPT subscription transport for independent, tool-free formal forecasts. */
import {execFileSync, spawn, spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import {lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir, userInfo} from "node:os";
import {dirname, join} from "node:path";
import type {LlmClient, LlmCompletion, LlmRequest, ReasoningConfiguration} from "./client.js";
import {ProviderApiError} from "./openai-compatible.js";
import {sha256} from "../tracing/trace-archive.js";

export const CODEX_NONE_SYSTEM = "Follow the historical information boundary and JSON response contract in the question.\n\nNo retrieval tools are available for this forecast.";
export const CODEX_MODEL = "gpt-5.6-sol";
export const CODEX_FEATURES_OFF = [
  "apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use",
  "in_app_browser", "in_app_chat", "in_app_local_automation", "multi_agent", "multi_agent_v2",
  "shell_tool", "unified_exec", "shell_snapshot", "view_image", "image_generation", "plugins",
  "remote_plugin", "skill_search", "skill_mcp_dependency_install", "memories", "hooks", "goals",
  "sleep_tool", "tool_suggest", "workspace_dependencies", "code_mode", "code_mode_host", "personality",
] as const;

export type CodexAccount = "team" | "personal";
export function personalCodexHome():string { return join(userInfo().homedir,".codex-raven-personal"); }

/** Stable account identity only; never expose, hash or store access/refresh tokens in traces. */
export function inspectPersonalCodexAuth(home=personalCodexHome()):string {
  for(const path of [home,join(home,"auth.json")]) {
    const st=lstatSync(path);
    if(st.isSymbolicLink() || st.uid!==process.getuid?.() || (st.mode & 0o077)!==0 ||
       (path===home ? !st.isDirectory() : !st.isFile()))
      throw new Error("Personal Codex credentials require an owner-only directory and regular auth file");
  }
  const auth=JSON.parse(readFileSync(join(home,"auth.json"),"utf8"));
  if(auth.auth_mode!=="chatgpt" || auth.OPENAI_API_KEY || !auth.tokens?.access_token ||
      !auth.tokens?.refresh_token || typeof auth.tokens?.account_id!=="string" || !auth.tokens.account_id)
    throw new Error("Personal Codex requires a saved ChatGPT login; API-key fallback is forbidden");
  return sha256(auth.tokens.account_id);
}
export function personalCodexEnvironment(home=personalCodexHome()):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={...process.env,CODEX_HOME:home};
  for(const key of ["OPENAI_API_KEY","OPENAI_BASE_URL","CODEX_API_KEY"]) delete env[key];
  return env;
}

/** No inference, credential values, or login changes. Pin the installed runtime in the condition. */
export function inspectCodexSubscription(account:CodexAccount="team") {
  const personal=account==="personal";
  const accountHash=personal ? inspectPersonalCodexAuth() : undefined;
  const command=personal ? "/usr/bin/codex" : "gpt-raven";
  const env=personal ? personalCodexEnvironment() : process.env;
  const version=execFileSync(command,["--version"],{env,encoding:"utf8",timeout:15_000}).trim().split("\n").at(-1)!;
  const login=spawnSync(command,["login","status"],{env,encoding:"utf8",timeout:15_000,stdio:["ignore","pipe","pipe"]});
  if(login.status!==0 || !(login.stdout+login.stderr).includes("Logged in using ChatGPT")) throw new Error("Selected Codex account must be logged in using ChatGPT; API billing fallback is forbidden");
  const featureText=execFileSync(command,["features","list"],{env,encoding:"utf8",timeout:15_000});
  const features=new Set(featureText.split("\n").map(line=>line.trim().split(/\s+/)[0]));
  if(CODEX_FEATURES_OFF.some(name=>!features.has(name))) throw new Error("Installed Codex lacks a required isolation feature switch");
  const entry=realpathSync("/usr/bin/codex");
  const platformPackage=createRequire(entry).resolve("@openai/codex-linux-x64/package.json");
  const binary=join(dirname(platformPackage),"vendor/x86_64-unknown-linux-musl/bin/codex");
  return {version, executable_sha256:sha256(readFileSync(binary)),
    entrypoint_sha256:sha256(readFileSync(entry)),
    wrapper_sha256:personal ? null : sha256(readFileSync("/usr/local/bin/gpt-raven")), authentication:"chatgpt_subscription",
    ...(personal ? {account:"personal" as const,account_identity_sha256:accountHash} : {})};
}

export function codexInput(req:LlmRequest) {
  const messages=req.messages??[{role:"system",content:req.system??""},{role:"user",content:req.prompt}];
  if(req.model && req.model!==CODEX_MODEL) throw new Error("Subscription model override is outside the authorized scope");
  if(req.effort!=="high") throw new Error("Codex subscription pilot requires explicit high effort");
  if(req.tools?.length || messages.length!==2 || messages[0]?.role!=="system" || messages[1]?.role!=="user" ||
      messages.some(m=>m.toolCalls?.length || m.toolCallId) || messages[0].content!==CODEX_NONE_SYSTEM)
    throw new Error("Codex pilot accepts only the reviewed none system and one fresh question, with no tools/history");
  return {system:messages[0].content,prompt:messages[1].content};
}

export function codexArguments(systemPath:string,emptyCwd:string,answerPath:string):string[] {
  return ["exec","--model",CODEX_MODEL,"--strict-config","--ignore-user-config","--ignore-rules",
    "--ephemeral","--json","--skip-git-repo-check","--sandbox","read-only","--cd",emptyCwd,
    "--output-last-message",answerPath,
    ...["forced_login_method=\"chatgpt\"","model_provider=\"openai\"","model_reasoning_effort=\"high\"",
      `model_instructions_file=${JSON.stringify(systemPath)}`,"developer_instructions=\"\"",
      "web_search=\"disabled\"","project_doc_max_bytes=0","approval_policy=\"never\"",
      "history.persistence=\"none\"","hide_agent_reasoning=false","show_raw_agent_reasoning=true",
      "model_reasoning_summary=\"auto\"","suppress_unstable_features_warning=true"].flatMap(value=>["-c",value]),
    ...CODEX_FEATURES_OFF.flatMap(name=>["--disable",name]),"--enable","skip_host_skill_discovery","-"];
}

/** Only textual model output is admissible. Unknown/tool items invalidate the entire cell. */
export function inspectCodexEvent(event:any) {
  // CLI 0.153.4 labels this expected isolation notice as an error item before turn.started.
  // It reports disabled infrastructure, not a model error or an executed tool.
  if(event.type==="item.completed" && event.item?.type==="error" && event.item.message===
      "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.") return;
  if(event.type?.startsWith("item.") && !["agent_message","reasoning"].includes(event.item?.type))
    throw new Error(`Closed-book violation or unsupported Codex item: ${event.item?.type}`);
  if(event.type==="error" || event.type==="turn.failed") throw new Error(`Codex failed: ${JSON.stringify(event.error??event.message)}`);
}

export class CodexSubscriptionClient implements LlmClient {
  readonly id:string;
  readonly traceMetadata:Readonly<Record<string,unknown>>;
  constructor(runtime=inspectCodexSubscription(),private readonly account:CodexAccount="team") {
    if((runtime.account==="personal") !== (account==="personal")) throw new Error("Codex runtime/account mismatch");
    this.id=`${account==="personal" ? "codex-personal" : "codex"}:${CODEX_MODEL}`;
    this.traceMetadata={harness:"codex-cli-none",base_url:account==="personal" ? "chatgpt-subscription-via-personal-codex" : "chatgpt-subscription-via-gpt-raven",
      runtime,model:CODEX_MODEL,credential_resource:account==="personal" ? `personal-chatgpt:${runtime.account_identity_sha256}` : "gpt-raven-chatgpt-subscription",
      pricing:{known:false,usd_cost_known:false,billing:"chatgpt_subscription"},
      isolation:{fresh_context:true,ephemeral:true,web_search:"disabled",disabled_features:CODEX_FEATURES_OFF,
        replay_cot:false,question_prompt:"verbatim",system_prompt:"model_instructions_file replacement",
        codex_environment_messages:"CLI may add environment/permission metadata; distinct harness"},
      reasoning_visibility:"Only CLI-returned reasoning items are observable; not a claim of full hidden CoT"};
  }
  reasoningConfiguration(effort?:string):ReasoningConfiguration {
    if(effort!=="high") throw new Error("Codex subscription pilot requires explicit high effort");
    return {reasoning_mode:"reasoning",thinking_effort:"high",requested_thinking_effort:"high",source:"explicit",
      api_parameters:{model_reasoning_effort:"high",harness_runtime:this.traceMetadata.runtime,
        isolation:this.traceMetadata.isolation}};
  }
  async complete(req:LlmRequest):Promise<LlmCompletion> {
    const input=codexInput(req);
    const personal=this.account==="personal";
    if(personal && inspectPersonalCodexAuth()!==(this.traceMetadata.runtime as any).account_identity_sha256)
      throw new Error("Personal Codex account changed after admission");
    const command=personal ? "/usr/bin/codex" : "gpt-raven";
    const env=personal ? personalCodexEnvironment() : process.env;
    const root=mkdtempSync(join(tmpdir(),"raven-codex-none-"));
    const cwd=join(root,"empty");mkdirSync(cwd,{mode:0o700});
    const systemPath=join(root,"system.txt"),answerPath=join(root,"answer.txt");
    writeFileSync(systemPath,input.system,{mode:0o600});
    const args=codexArguments(systemPath,cwd,answerPath);
    let raw="",stderr="",threadId:string|undefined,usage:any,completed=0;
    const reasoning:string[]=[];
    req.onTrace?.({type:"codex_invocation",data:{command,args,runtime:this.traceMetadata.runtime,
      system_sha256:sha256(input.system),prompt_sha256:sha256(input.prompt),billing:"chatgpt_subscription"}});
    try {
      await new Promise<void>((resolve,reject)=>{
        const child=spawn(command,args,{cwd,env,stdio:["pipe","pipe","pipe"],detached:true});
        let failure:Error|undefined;
        const stop=(error:Error)=>{failure??=error;try{process.kill(-child.pid!,"SIGTERM");}catch{}};
        const timeout=setTimeout(()=>stop(new Error("Codex cell exceeded 15 minute limit")),900_000);
        const interrupt=()=>stop(new Error("Codex cell interrupted by parent"));
        process.once("SIGTERM",interrupt);process.once("SIGINT",interrupt);
        function line(value:string) {
          if(!value.trim()) return;
          // The team wrapper emits this non-model informational line before exec.
          if(value.startsWith("[INFO] GPT-Raven direct CLI ")) return;
          try {
            const event=JSON.parse(value);
            req.onTrace?.({type:"codex_event",data:event});
            inspectCodexEvent(event);
            if(event.type==="thread.started") {if(threadId)throw new Error("Multiple Codex contexts in one cell");threadId=event.thread_id;}
            if(event.type==="turn.completed") {usage=event.usage;completed++;}
            if(event.type==="item.completed" && event.item.type==="reasoning") reasoning.push(event.item.text??"");
          } catch(error) {stop(error instanceof Error?error:new Error(String(error)));}
        }
        child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
        child.stdout.on("data",(part:string)=>{raw+=part;let end;while((end=raw.indexOf("\n"))>=0){line(raw.slice(0,end));raw=raw.slice(end+1);}});
        child.stderr.on("data",(part:string)=>{stderr+=part;});
        child.on("error",error=>{failure=error;});
        child.on("close",code=>{
          clearTimeout(timeout);process.removeListener("SIGTERM",interrupt);process.removeListener("SIGINT",interrupt);
          if(raw.trim()) line(raw);
          if(stderr) req.onTrace?.({type:"codex_stderr",data:{text:stderr}});
          if(failure) reject(failure);
          else if(code!==0 || completed!==1 || !threadId) reject(new Error(`Codex exit=${code}; completed_turns=${completed}; ${stderr.slice(-2000)}`));
          else resolve();
        });
        child.stdin.on("error",()=>{});child.stdin.end(input.prompt);
      });
      const text=readFileSync(answerPath,"utf8"),cot=reasoning.join("\n\n");
      const capture={policy:"raven.provider-reasoning.v1" as const,status:cot.trim()?"text_returned" as const:"not_returned" as const,
        native_fields:reasoning.length?["codex.item.reasoning"]:[],native_frames:reasoning.length,native_trace_enabled:!!req.onTrace,
        readable_source:reasoning.length?"codex.item.reasoning (may be summary)":null,readable_chars:cot.length,
        readable_sha256:sha256(cot),stream_complete:true};
      req.onTrace?.({type:"provider_reasoning_capture",data:capture});
      return {text,reasoning:cot,reasoningCapture:capture,costUsd:0,
        inputTokens:usage?.input_tokens??0,outputTokens:usage?.output_tokens??0,cachedInputTokens:usage?.cached_input_tokens,
        reasoningTokens:usage?.reasoning_output_tokens,provider:{responseId:threadId},finishReason:"stop"};
    } catch(error) {
      req.onTrace?.({type:"codex_failed_capture",data:{stream_complete:false,reasoning_items:reasoning.length,
        partial_json_line:raw,error:String(error)}});
      // Never auto-retry an uncertain subscription generation, model fallback or a tool violation.
      throw new ProviderApiError(this.id,400,"http_error",false,"codex_no_automatic_retry",String(error));
    } finally {rmSync(root,{recursive:true,force:true});}
  }
}
