/** Native Claude session with an isolated loopback MCP bridge to FABench's tool executor. */
import {claudeTokenUsage} from "./claude-usage.js";
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createServer, type Server, type ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {LlmClient,LlmCompletion,LlmRequest,LlmMessage,ToolSpec} from './benchmark-client.js';
import {CLAUDE_MODEL,CLAUDE_COMMAND,claudeArguments,claudeWindowExhausted,inspectClaudeRateLimitError,type ClaudeModel} from './claude-subscription.js';
import {ProviderApiError} from './openai-compatible.js';
import {sha256} from '../tracing/trace-archive.js';

const prefix='mcp__raven__';
export function claudeRetrievalTools(tools:ToolSpec[]) {
  if(!tools.length || new Set(tools.map(t=>t.name)).size!==tools.length || tools.some(t=>!['web_search','web_fetch'].includes(t.name)))
    throw new Error('Claude retrieval exposes only FABench web_search/web_fetch');
  // The native CLI has a separate 50k-character persistence threshold, even when
  // MAX_MCP_OUTPUT_TOKENS is raised. This metadata raises its supported ceiling;
  // it is transport metadata, not a change to the model-facing tool definition.
  // FABench's shared paged tool delivery keeps results below this ceiling and offers
  // continuation through web_fetch. The exact-result check still detects unexpected
  // CLI rewrites; legacy inline runs can still exceed the ceiling.
  return tools.map(t=>({name:t.name,description:t.description,inputSchema:t.parameters,
    _meta:{'anthropic/maxResultSizeChars':500_000}}));
}
/** Claude Code 2.1.280 probes MCP's 2026-07-28 discovery method before listing tools. */
export function claudeMcpDiscovery() {
  return {resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{}},
    _meta:{'io.modelcontextprotocol/serverInfo':{name:'raven',version:'1'}}};
}
export function inspectClaudeRetrievalEvent(event:any,names:Set<string>,expectedModel:ClaudeModel=CLAUDE_MODEL) {
  inspectClaudeRateLimitError(event);
  if(event.type==='system') {
    if(event.subtype==='thinking_tokens')return;
    if(event.subtype!=='init') throw new Error(`Unsupported Claude system activity: ${event.subtype}`);
    if(!Array.isArray(event.tools) || event.tools.length!==names.size || event.tools.some((n:string)=>!names.has(n)))
      throw new Error('Claude retrieval tool surface differs from the FABench allowlist');
    if(event.mcp_servers?.length!==1 || event.mcp_servers[0].name!=='raven' || event.mcp_servers[0].status!=='connected')
      throw new Error('Claude must connect only to the FABench MCP bridge');
  } else if(event.type==='assistant') {
    if(event.message?.model!==expectedModel) throw new Error('Claude retrieval model changed');
    for(const b of event.message.content??[]) {
      if(b.type==='tool_use') {if(!names.has(b.name))throw new Error(`Unauthorized Claude tool: ${b.name}`);}
      else if(!['text','thinking','redacted_thinking'].includes(b.type))throw new Error(`Unsupported Claude block: ${b.type}`);
    }
  } else if(event.type==='user') {
    if(!Array.isArray(event.message?.content) || event.message.content.some((b:any)=>b.type!=='tool_result'))
      throw new Error('Unexpected Claude native user message');
  } else if(event.type==='tool_progress') {
    // Long MCP calls emit native heartbeat telemetry. It is archived by the
    // caller, but must neither end the forecast nor become evidence/accounting.
    // Accept only the observed FABench heartbeat shape, not subagent activity.
    if(event.heartbeat!==true || !names.has(event.tool_name) ||
      typeof event.tool_use_id!=='string' || !event.tool_use_id ||
      typeof event.parent_tool_use_id!=='string' || !event.parent_tool_use_id ||
      !Number.isFinite(event.elapsed_time_seconds) || event.elapsed_time_seconds<0 ||
      event.task_id!=null || event.subagent_type!=null || event.subagent_retry!=null)
      throw new Error('Unsupported Claude tool progress activity');
  } else if(event.type==='result') {
    if(event.is_error || event.subtype!=='success')throw new Error(`Claude failed: ${event.result??event.subtype}`);
    for(const model of Object.keys(event.modelUsage??{}))if(model!==expectedModel)throw new Error(`Auxiliary model: ${model}`);
  } else if(event.type!=='rate_limit_event')throw new Error(`Unsupported Claude event: ${event.type}`);
}
export class ClaudeRetrievalForecast implements LlmClient {
  readonly id:string;
  private child?:ChildProcessWithoutNullStreams;
  private server?:Server;
  private root?:string;
  private timer?:ReturnType<typeof setTimeout>;
  private closed=false;
  private failed?:Error;
  private queue:LlmCompletion[]=[];
  private waiter?:{resolve:(v:LlmCompletion)=>void;reject:(e:Error)=>void};
  private pending=new Map<string,{response:ServerResponse;rpcId:unknown}>();
  private delivered=new Set<string>();
  private expectedNativeResults:string[]=[];
  private seen:LlmMessage[]=[];
  private effort?:string;
  private toolDefinitions?:string;
  private trace?:LlmRequest['onTrace'];
  private thinking:string[]=[];
  private artifacts=0;
  private frames=0;
  private rateLimit:any;
  private result:any;
  private sessionId?:string;
  private busy=false;
  private interrupt=()=>this.fail(new Error('Claude retrieval interrupted'));
  constructor(readonly traceMetadata:Readonly<Record<string,unknown>>,private readonly model:ClaudeModel=CLAUDE_MODEL) {
    this.id=`claude:${model}`;
  }
  private fail(error:Error) {
    if(this.failed||this.closed)return;
    const exhausted=claudeWindowExhausted(this.rateLimit,String(error));
    this.failed=new ProviderApiError(this.id,exhausted?429:400,exhausted?'insufficient_balance':'http_error',false,
      exhausted?'claude_subscription_window_exhausted':'claude_no_automatic_retry',String(error));
    this.trace?.({type:'claude_failed_capture',data:{error:String(error),stream_complete:false,window_exhausted:exhausted,rate_limit:this.rateLimit}});
    this.waiter?.reject(this.failed);this.waiter=undefined;this.close();
  }
  close() {
    if(this.closed)return;this.closed=true;
    clearTimeout(this.timer);process.removeListener('SIGTERM',this.interrupt);process.removeListener('SIGINT',this.interrupt);
    for(const p of this.pending.values())p.response.destroy();this.pending.clear();
    this.server?.closeAllConnections();this.server?.close();
    const root=this.root;
    if(this.child && this.child.exitCode===null && this.child.signalCode===null) {
      const child=this.child;
      child.once('close',()=>{if(root)rmSync(root,{recursive:true,force:true});});
      try{process.kill(-child.pid!,'SIGTERM');}catch{child.kill();}
      const timer=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},2000);timer.unref();
      child.once('close',()=>clearTimeout(timer));
    } else if(root)rmSync(root,{recursive:true,force:true});
  }
  private emit(call?:{id:string;name:string;args:Record<string,unknown>}) {
    const reasoning=this.thinking.join('\n\n'), usage=call?{}:this.result?.usage??{};
    const capture={policy:'raven.provider-reasoning.v1' as const,status:reasoning?'text_returned' as const:this.artifacts?'artifact_only' as const:this.frames?'empty' as const:'not_returned' as const,
      native_fields:this.frames?['claude.assistant.thinking']:[],native_frames:this.frames,native_trace_enabled:!!this.trace,
      readable_source:reasoning?'claude.assistant.thinking':null,readable_chars:reasoning.length,readable_sha256:sha256(reasoning),stream_complete:!call};
    const part:LlmCompletion={text:call?'':this.result.result,reasoning,reasoningCapture:capture,costUsd:0,
      ...claudeTokenUsage(usage),
      provider:{responseId:this.sessionId,model:this.model},finishReason:call?'tool_calls':'stop',...(call?{toolCalls:[call]}:{})};
    if(!call)this.trace?.({type:'claude_cell_accounting',data:{native_usage:usage,model_usage:this.result?.modelUsage,rate_limit:this.rateLimit,billing:'claude_subscription',usd_cost_known:false}});
    this.trace?.({type:'provider_reasoning_capture',data:capture});this.thinking=[];this.frames=0;this.artifacts=0;
    if(this.waiter){const w=this.waiter;this.waiter=undefined;w.resolve(part);}else this.queue.push(part);
  }
  private async start(req:LlmRequest,messages:LlmMessage[]) {
    if(messages.length!==2||messages[0]!.role!=='system'||messages[1]!.role!=='user'||
      !messages[0]!.content.startsWith('Follow the historical information boundary and JSON response contract in the question.'))
      throw new Error('Claude retrieval requires the reviewed system and one fresh question');
    const tools=claudeRetrievalTools(req.tools??[]),names=new Set(tools.map(t=>prefix+t.name));
    this.effort=req.effort;this.toolDefinitions=JSON.stringify(req.tools);
    // Random capability URL, loopback-only listener, no repository or network access offered to Claude.
    const path='/'+randomUUID();
    this.server=createServer(async (request,response)=>{
      try {
        if(request.url!==path){response.writeHead(404).end();return;}
        if(request.method!=='POST'){response.writeHead(405).end();return;}
        let raw='';for await(const chunk of request){raw+=chunk;if(raw.length>1_000_000)throw new Error('Oversized MCP request');}
        const rpc=JSON.parse(raw);
        const reply=(result:any)=>{response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));};
        if(rpc.id===undefined){response.writeHead(202).end();return;}
        if(rpc.method==='server/discover')reply(claudeMcpDiscovery());
        else if(rpc.method==='initialize')reply({protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'raven',version:'1'}});
        else if(rpc.method==='ping')reply({resultType:'complete'});
        else if(rpc.method==='tools/list')reply({resultType:'complete',tools,ttlMs:0,cacheScope:'private'});
        else if(rpc.method==='tools/call') {
          const {name,arguments:args}=rpc.params??{};
          if(!names.has(prefix+name)||!args||typeof args!=='object'||Array.isArray(args))throw new Error('Unauthorized MCP tool request');
          const id=randomUUID();this.pending.set(id,{response,rpcId:rpc.id});
          this.trace?.({type:'claude_raven_tool_request',data:{id,name,args}});
          this.emit({id,name,args});
        } else throw new Error(`Unsupported MCP method: ${rpc.method}`);
      }catch(e){response.destroy();this.fail(e instanceof Error?e:new Error(String(e)));}
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(0,'127.0.0.1',resolve);});
    const address=this.server.address() as {port:number};
    this.root=mkdtempSync(join(tmpdir(),'raven-claude-tools-'));
    const cwd=join(this.root,'empty'),config=join(this.root,'config');mkdirSync(cwd,{mode:0o700});mkdirSync(config,{mode:0o700});
    const args=[...claudeArguments(messages[0]!.content,cwd,req.effort,this.model),
      '--mcp-config',JSON.stringify({mcpServers:{raven:{type:'http',url:`http://127.0.0.1:${address.port}${path}`}}}),
      '--allowedTools',...names,'--disable-slash-commands','--no-session-persistence'];
    const env={...process.env,CLAUDE_RAVEN_CONFIG_DIR:config,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_AUTO_COMPACT:'1',MCP_TOOL_TIMEOUT:'1800000',ENABLE_TOOL_SEARCH:'false',MAX_MCP_OUTPUT_TOKENS:'10000000'};
    delete (env as NodeJS.ProcessEnv).ANTHROPIC_API_KEY;delete (env as NodeJS.ProcessEnv).ANTHROPIC_AUTH_TOKEN;
    this.trace?.({type:'claude_retrieval_invocation',data:{system:messages[0]!.content,prompt:messages[1]!.content,tools,
      system_sha256:sha256(messages[0]!.content),prompt_sha256:sha256(messages[1]!.content),harness:'claude-cli-raven-mcp-v1'}});
    this.child=spawn(CLAUDE_COMMAND,args,{cwd,env,stdio:'pipe',detached:true});
    this.timer=setTimeout(()=>this.fail(new Error('Claude retrieval exceeded 30 minute limit')),1800000);
    process.once('SIGTERM',this.interrupt);process.once('SIGINT',this.interrupt);
    let buffer='',stderr='';
    const line=(raw:string)=>{if(!raw.trim())return;try{
      const event=JSON.parse(raw);this.trace?.({type:'claude_event',data:event});
      if(event.type==='rate_limit_event')this.rateLimit=event.rate_limit_info;
      inspectClaudeRetrievalEvent(event,names,this.model);
      if(event.type==='system'&&event.subtype==='init'){if(this.sessionId)throw new Error('Multiple Claude sessions');this.sessionId=event.session_id;}
      if(event.type==='assistant')for(const b of event.message.content??[]) {
        if(b.type==='thinking'){this.frames++;if(b.thinking)this.thinking.push(b.thinking);}
        if(b.type==='redacted_thinking'){this.frames++;this.artifacts++;}
      }
      if(event.type==='user')for(const b of event.message.content) {
        const index=this.expectedNativeResults.indexOf(JSON.stringify(b.content));
        if(index<0 || b.is_error)throw new Error('Claude native tool result differs from FABench output');
        this.expectedNativeResults.splice(index,1);
      }
      if(event.type==='result'){if(this.result)throw new Error('Multiple Claude results');this.result=event;}
    }catch(e){this.fail(e instanceof Error?e:new Error(String(e)));}};
    this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data',(s:string)=>{buffer+=s;let i;while((i=buffer.indexOf('\n'))>=0){line(buffer.slice(0,i));buffer=buffer.slice(i+1);}});
    this.child.stderr.on('data',(s:string)=>{stderr=(stderr+s).slice(-8000);});
    this.child.stdin.on('error',e=>this.fail(e));this.child.on('error',e=>this.fail(e));
    this.child.on('close',code=>{
      if(this.closed)return;if(buffer.trim())line(buffer);if(this.closed)return;
      if(code!==0||!this.result||!this.sessionId||this.pending.size||this.expectedNativeResults.length||!this.result.result)
        this.fail(new Error(`Claude exit=${code}; incomplete retrieval: ${stderr}`));
      else {this.emit();this.close();}
    });
    this.child.stdin.end(messages[1]!.content);
  }
  async complete(req:LlmRequest):Promise<LlmCompletion> {
    if(this.busy)throw new Error('Concurrent Claude forecast calls');this.busy=true;this.trace=req.onTrace;
    try {
      if(this.failed)throw this.failed;if(this.closed)throw new Error('Closed Claude forecast');
      if(req.model&&req.model!==this.model)throw new Error('Claude model override forbidden');
      const messages=req.messages??[{role:'system' as const,content:req.system??''},{role:'user' as const,content:req.prompt}];
      if(!this.child)await this.start(req,messages);
      else {
        if(req.effort!==this.effort||JSON.stringify(messages.slice(0,this.seen.length))!==JSON.stringify(this.seen))throw new Error('Claude history or effort changed');
        if(req.tools?.length && JSON.stringify(req.tools)!==this.toolDefinitions)throw new Error('Claude tool definitions changed');
        const appended=messages.slice(this.seen.length),results=appended.filter(m=>m.role==='tool');
        if(results.length!==this.delivered.size||new Set(results.map(m=>m.toolCallId)).size!==results.length||
          results.some(m=>!m.toolCallId||!this.delivered.has(m.toolCallId))||appended.some(m=>m.role==='system'))
          throw new Error('Claude tool results do not match delivered calls');
        const notices=appended.filter(m=>m.role==='user');
        if(notices.length&&req.tools?.length)throw new Error('Unexpected Claude user continuation');
        for(const [i,result] of results.entries()) {
          const pending=this.pending.get(result.toolCallId!)!;this.pending.delete(result.toolCallId!);
          const content=[{type:'text',text:result.content},...(i===results.length-1?notices.map(m=>({type:'text',text:m.content})):[])];
          this.trace?.({type:'claude_raven_tool_response',data:{id:result.toolCallId,content,budget_notice_delivery:notices.length?'separate MCP content block':null}});
          this.expectedNativeResults.push(JSON.stringify(content));
          pending.response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:pending.rpcId,result:{resultType:'complete',content,isError:false}}));
        }
        this.delivered.clear();
      }
      this.seen=structuredClone(messages);
      const part=this.queue.shift()??await new Promise<LlmCompletion>((resolve,reject)=>{if(this.failed)reject(this.failed);else this.waiter={resolve,reject};});
      for(const call of part.toolCalls??[])this.delivered.add(call.id);
      return part;
    } catch(e){this.fail(e instanceof Error?e:new Error(String(e)));throw this.failed??e;}finally{this.busy=false;}
  }
}
