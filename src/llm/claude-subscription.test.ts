import assert from "node:assert/strict";
import test from "node:test";
import {CLAUDE_NONE_SYSTEM, CLAUDE_MODEL, CLAUDE_OPUS_55_MODEL, CLAUDE_TOOLS_OFF, claudeInput, claudeArguments,
  inspectClaudeEvent, ClaudeSubscriptionClient, tokenFingerprint, claudeWindowExhausted} from "./claude-subscription.js";
import {CODEX_NONE_SYSTEM} from "./codex-subscription.js";
import {formalArguments} from "../experiments/environment-check.js";
import {PKG_ROOT} from "../paths.js";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const runtime = {cli_version: "2.1.266 (Claude Code)", wrapper_build: "cc000f23", executable_sha256: "test",
  wrapper_sha256: "test", authentication: "claude_subscription_oauth", credential_fingerprint: "f41f489dd17c"};
const request = {system: CLAUDE_NONE_SYSTEM, prompt: "Question bytes\nremain unchanged"};

test("the two subscription harnesses share one reviewed closed-book system", () => {
  assert.equal(CLAUDE_NONE_SYSTEM, CODEX_NONE_SYSTEM);
});

test("Opus 5.5 keeps the reviewed prompt and rejects model fallback", () => {
  const client = new ClaudeSubscriptionClient(runtime, CLAUDE_OPUS_55_MODEL);
  assert.equal(client.id, `claude:${CLAUDE_OPUS_55_MODEL}`);
  assert.deepEqual(claudeInput({...request, model: CLAUDE_OPUS_55_MODEL}, CLAUDE_OPUS_55_MODEL),
    {system: request.system, prompt: request.prompt});
  assert.equal(claudeArguments(request.system, '/empty', undefined, CLAUDE_OPUS_55_MODEL)[2], CLAUDE_OPUS_55_MODEL);
  inspectClaudeEvent({type: 'assistant', message: {model: CLAUDE_OPUS_55_MODEL, content: [{type: 'text'}]}}, CLAUDE_OPUS_55_MODEL);
  assert.throws(() => inspectClaudeEvent({type: 'assistant', message: {model: CLAUDE_MODEL, content: [{type: 'text'}]}}, CLAUDE_OPUS_55_MODEL), /Model fallback/);
  assert.throws(() => inspectClaudeEvent({type: 'result', subtype: 'success', modelUsage: {[CLAUDE_MODEL]: {}}}, CLAUDE_OPUS_55_MODEL), /Auxiliary model/);
  const admitted = formalArguments(['--profile','custom','--llm',`claude:${CLAUDE_OPUS_55_MODEL}`,'--settings','none,frozen','--conc','4','--questions-file','questions.jsonl','--grading-file','grading.jsonl'], PKG_ROOT);
  assert.equal(admitted.selected.llm, `claude:${CLAUDE_OPUS_55_MODEL}`);
});

test("subscription requests keep exact prompts and reject tools/history/model changes", () => {
  assert.deepEqual(claudeInput(request), {system: request.system, prompt: request.prompt});
  for (const patch of [{system: "changed"}, {model: "claude-sonnet-5"},
    {tools: [{name: "web_search", description: "search", parameters: {}}]},
    {messages: [{role: "system", content: CLAUDE_NONE_SYSTEM}, {role: "user", content: "q"}, {role: "assistant", content: "history"}]}])
    assert.throws(() => claudeInput({...request, ...patch} as any));
});

test("arguments pin the closed-book flags and deny every built-in tool", () => {
  const args = claudeArguments(CLAUDE_NONE_SYSTEM, "/isolated/empty");
  for (const value of ["-p", "--strict-mcp-config", "--restricted", "--permission-mode", "dontAsk",
    "--output-format", "stream-json", "--system-prompt", CLAUDE_NONE_SYSTEM, CLAUDE_MODEL])
    assert.ok(args.includes(value), value);
  for (const tool of ["WebSearch", "WebFetch", "Bash", "Read", "Task", "Skill"])
    assert.ok(args.includes(tool), `must deny ${tool}`);
  assert.equal(args.includes("--effort"), false);
  assert.ok(claudeArguments(CLAUDE_NONE_SYSTEM, "/isolated/empty", "high").includes("high"));
  const client = new ClaudeSubscriptionClient(runtime);
  assert.equal(client.id, `claude:${CLAUDE_MODEL}`);
  assert.equal((client.traceMetadata.pricing as any).usd_cost_known, false);
  assert.equal(client.traceMetadata.harness, "claude-cli-raven-mcp-v1");
  assert.equal(client.reasoningConfiguration().source, "provider-default");
  assert.equal(client.reasoningConfiguration("high").thinking_effort, "high");
});

test("an offered tool, an unknown event or a failed result cannot yield a score", () => {
  inspectClaudeEvent({type: "system", subtype: "init", tools: [], mcp_servers: []});
  assert.throws(() => inspectClaudeEvent({type: "system", subtype: "init", tools: ["WebSearch"], mcp_servers: []}),
    /Closed-book violation/);
  assert.throws(() => inspectClaudeEvent({type: "system", subtype: "init", tools: [], mcp_servers: [{name: "x"}]}),
    /Closed-book violation/);
  for (const type of ["text", "thinking"]) inspectClaudeEvent({type: "assistant", message: {content: [{type}]}});
  for (const type of ["tool_use", "server_tool_use", "mcp_tool_use", "tool_result"])
    assert.throws(() => inspectClaudeEvent({type: "assistant", message: {content: [{type}]}}));
  inspectClaudeEvent({type: "result", subtype: "success", is_error: false});
  assert.throws(() => inspectClaudeEvent({type: "result", subtype: "success", is_error: true}));
  assert.throws(() => inspectClaudeEvent({type: "result", subtype: "error_max_turns", is_error: false}));
  assert.throws(() => inspectClaudeEvent({type: "user", message: {content: []}}), /Unsupported Claude CLI event/);
});

test("a swapped model or an auxiliary model billed inside the cell fails it", () => {
  inspectClaudeEvent({type: "assistant", message: {model: CLAUDE_MODEL, content: [{type: "text"}]}});
  assert.throws(() => inspectClaudeEvent({type: "assistant", message: {model: "claude-haiku-4-5", content: [{type: "text"}]}}),
    /Model fallback/);
  inspectClaudeEvent({type: "result", subtype: "success", is_error: false, modelUsage: {[CLAUDE_MODEL]: {inputTokens: 1}}});
  assert.throws(() => inspectClaudeEvent({type: "result", subtype: "success", is_error: false,
    modelUsage: {[CLAUDE_MODEL]: {inputTokens: 1}, "claude-haiku-4-5-20251001": {inputTokens: 901}}}),
    /Auxiliary model billed inside the cell/);
});

test("a spent subscription window pauses the run instead of failing every remaining cell", () => {
  assert.equal(claudeWindowExhausted({status: "allowed", overageStatus: "rejected"}, "Claude exit=1"), false);
  assert.equal(claudeWindowExhausted({status: "warning"}, "Claude exit=1"), false);
  assert.equal(claudeWindowExhausted({status: "allowed_warning"}, "Claude exit=1"), false);
  assert.equal(claudeWindowExhausted({status: "unrecognized"}, "Claude exit=1"), false);
  assert.equal(claudeWindowExhausted({status: "rejected"}, "Claude exit=1"), true);
  assert.equal(claudeWindowExhausted(undefined, "Claude usage limit reached; resets at 6pm"), true);
  assert.equal(claudeWindowExhausted(undefined, "You've hit your weekly limit · resets Mon 12am"), true);
  assert.equal(claudeWindowExhausted(undefined, "Closed-book violation: CLI offered tools WebSearch"), false);
});

test('native synthetic quota errors retain their category before model validation',()=>{
  assert.throws(()=>inspectClaudeEvent({type:'assistant',error:'rate_limit',message:{model:'<synthetic>',
    content:[{type:'text',text:"You've hit your limit · resets 11pm"}]}}),/Claude rate limit/);
});

test("an exhausted window is reported as a non-retryable balance failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-fake-limit-")), oldPath = process.env.PATH;
  writeFileSync(join(dir, "claude-raven"), `#!${process.execPath}
process.stdin.resume();process.stdin.on('end',()=>{
for(const event of [{type:'system',subtype:'init',session_id:'s',tools:[],mcp_servers:[]},
{type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'five_hour',resetsAt:1789845600}}])console.log(JSON.stringify(event));
process.exit(1);});
`, {mode: 0o700});
  process.env.PATH = dir + ":" + oldPath;
  try {
    const client = new ClaudeSubscriptionClient(runtime);
    await assert.rejects(() => client.complete({...request} as any), (error: any) => {
      assert.equal(error.category, "insufficient_balance");
      assert.equal(error.retryable, false);
      assert.equal(error.status, 429);
      return true;
    });
  } finally {process.env.PATH = oldPath; rmSync(dir, {recursive: true, force: true});}
});

test("shared admission restricts Claude to the exact model and reviewed retrieval arms", () => {
  const args = ["--profile", "custom", "--llm", `claude:${CLAUDE_MODEL}`, "--settings", "none", "--conc", "2",
    "--questions-file", "/data/questions.jsonl", "--grading-file", "/data/grading.jsonl"];
  assert.equal(formalArguments(args, PKG_ROOT).selected.llm, `claude:${CLAUDE_MODEL}`);
  for(const arm of ['frozen','web-filter','none,frozen,web-filter']) {
    const configured=[...args.map(x=>x==='none'?arm:x),'--leak-llm','deepseek:deepseek-flash'];
    assert.equal(formalArguments(configured,PKG_ROOT).selected.settings,arm);
    if(arm.includes('web-filter')) assert.throws(()=>formalArguments([...configured,'--leak-filter','0'],PKG_ROOT));
  }
  for (const [before, after] of [["none", "web"], [`claude:${CLAUDE_MODEL}`, "claude:claude-sonnet-5"]])
    assert.throws(() => formalArguments(args.map(x => x === before ? after! : x), PKG_ROOT));
});

test("the shared credential is identified by fingerprint and never by value", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-cred-"));
  try {
    const path = join(dir, "auth.env");
    writeFileSync(path, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-" + "a".repeat(95) + "\n");
    const fingerprint = tokenFingerprint(path);
    assert.match(fingerprint, /^[0-9a-f]{12}$/);
    writeFileSync(path, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-api03-not-a-subscription-token\n");
    assert.throws(() => tokenFingerprint(path), /long-lived subscription token/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test("CLI transport archives returned thinking and requires exactly one completed turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-fake-")), oldPath = process.env.PATH;
  const executable = join(dir, "claude-raven");
  writeFileSync(executable, `#!${process.execPath}
const args=process.argv.slice(2);let input='';
process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
if(input!==${JSON.stringify(request.prompt)})process.exit(4);
if(args[args.indexOf('--system-prompt')+1]!==${JSON.stringify(CLAUDE_NONE_SYSTEM)})process.exit(5);
if(!process.env.CLAUDE_RAVEN_CONFIG_DIR)process.exit(6);
for(const event of [{type:'system',subtype:'init',session_id:'fake-session',tools:[],mcp_servers:[]},
{type:'assistant',message:{model:'claude-opus-5',content:[{type:'thinking',thinking:'Returned summary'},{type:'text',text:'forecast'}]}},
{type:'result',subtype:'success',is_error:false,num_turns:1,result:'forecast',session_id:'fake-session',
 usage:{input_tokens:12,output_tokens:7,cache_read_input_tokens:3,cache_creation_input_tokens:10,output_tokens_details:{thinking_tokens:5}}}])console.log(JSON.stringify(event));
});
`, {mode: 0o700});
  process.env.PATH = dir + ":" + oldPath;
  try {
    const events: any[] = [];
    const client = new ClaudeSubscriptionClient(runtime);
    const completion = await client.complete({...request, onTrace: (event: any) => events.push(event)} as any);
    assert.equal(completion.text, "forecast");
    assert.equal(completion.reasoning, "Returned summary");
    assert.equal(completion.costUsd, 0);
    assert.equal(completion.inputTokens, 25);
    assert.equal(completion.outputTokens, 7);
    assert.equal(completion.cachedInputTokens, 3);
    assert.equal(completion.cacheWriteInputTokens, 10);
    assert.equal(completion.reasoningTokens, 5);
    assert.equal(completion.provider?.responseId, "fake-session");
    assert.ok(events.some(e => e.type === "claude_invocation"));
    assert.ok(events.some(e => e.type === "provider_reasoning_capture" && e.data.status === "text_returned"));
    assert.equal(CLAUDE_TOOLS_OFF.includes("WebSearch" as any), true);
  } finally {process.env.PATH = oldPath; rmSync(dir, {recursive: true, force: true});}
});

test("a tool call in the stream fails the cell and is never retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-fake-tool-")), oldPath = process.env.PATH;
  writeFileSync(join(dir, "claude-raven"), `#!${process.execPath}
process.stdin.resume();process.stdin.on('end',()=>{
for(const event of [{type:'system',subtype:'init',session_id:'s',tools:[],mcp_servers:[]},
{type:'assistant',message:{content:[{type:'tool_use',name:'WebSearch'}]}},
{type:'result',subtype:'success',is_error:false,num_turns:2,result:'forecast',usage:{}}])console.log(JSON.stringify(event));
});
`, {mode: 0o700});
  process.env.PATH = dir + ":" + oldPath;
  try {
    const client = new ClaudeSubscriptionClient(runtime);
    await assert.rejects(() => client.complete({...request} as any), (error: any) => {
      assert.equal(error.retryable, false);
      assert.match(String(error.message ?? error), /Closed-book violation|claude_no_automatic_retry/);
      return true;
    });
  } finally {process.env.PATH = oldPath; rmSync(dir, {recursive: true, force: true});}
});
