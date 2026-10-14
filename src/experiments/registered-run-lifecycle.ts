/** Registry-backed team notices and per-run publication. Never contains credentials. */
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {ExperimentRegistry, type ConfiguredRegistryRun, type RegistryRunRow} from "./registry.js";
import {sendToFeishu} from "./progress-report.js";
import {sha256} from "../tracing/trace-archive.js";
import { projectEnv } from "../env-names.js";

type Sender = (message: string) => Promise<unknown>;
const sendText: Sender = message => sendToFeishu({msg_type:"text",content:{text:message}});
const batchChildNotice = () => projectEnv("FABENCH_REGISTERED_NOTICE_POLICY") === "batch-child";
function json(path: string, value: unknown) {
  mkdirSync(dirname(path), {recursive:true, mode:0o2770});
  const tmp=`${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value,null,2)+"\n", {mode:0o640});
  renameSync(tmp,path);
}
export function registeredMessage(run: ConfiguredRegistryRun, event: "start" | "terminal", publication?: string): string {
  if (run.config.execution_mode === 'retrieval-validation') {
    const manifest=run.traceDirectory&&existsSync(join(run.traceDirectory,'manifest.json'))?JSON.parse(readFileSync(join(run.traceDirectory,'manifest.json'),'utf8')):null;
    return [`FABench | ${event==='start'?'registered, about to start':'results published'} | web fetch and time-review sample experiment`,
      `run_id: ${run.runId}`,`owner: ${run.owner}`,`mode: ${String(run.config.diagnostic_mode)}; model: ${String(run.config.model)}`,
      `page samples: ${String(run.config.sample_count)}; conc: ${String(run.config.conc)}`,
      ...(event==='terminal'?[`status: ${run.storedStatus}; result: ${JSON.stringify(manifest?.summary??{})}`]:[]),
      `trace: ${run.traceDirectory}`,...(publication?[`publication record: ${publication}`]:[]),
      'Checks fetching and review on fixed candidates/URLs; adds no forecast probability and does not count toward forecast scores.'].join('\n');
  }
  if (run.config.execution_mode === "reader-cleaning") {
    const manifest = run.traceDirectory && existsSync(join(run.traceDirectory,"manifest.json"))
      ? JSON.parse(readFileSync(join(run.traceDirectory,"manifest.json"),"utf8")) : null;
    return [`FABench | ${event === "start" ? "registered, about to start" : "results published"} | Reader page-cleaning sample experiment`,
      `run_id: ${run.runId}`, `owner: ${run.owner}`, `model: ${String(run.config.model)}`,
      `page samples: ${String(run.config.sample_count)}; conc: ${String(run.config.conc)}`,
      ...(event === "terminal" ? [`status: ${run.storedStatus}; result: ${JSON.stringify(manifest?.summary ?? {})}`] : []),
      `trace: ${run.traceDirectory}`, ...(publication ? [`publication record: ${publication}`] : []),
      "Tests source-text retention and boilerplate cleaning; no forecast probability produced; not counted toward forecast scores."].join("\n");
  }
  const conditions=Array.isArray(run.config.conditions)?run.config.conditions:[];
  const mode=run.config.execution_mode === "postprocess" ? "raw-output review (no new model calls)" : "model experiment";
  return [
    `FABench | ${event === "start" ? "registered, about to start" : "results published"} | ${mode}`,
    `run_id: ${run.runId}`, `tag: ${run.tag}`, `owner: ${run.owner}`,
    `conditions: ${conditions.map((x:any)=>`${x.model} / ${x.arm}`).join(", ")}`,
    `question set: ${String(run.config.question_set_id ?? run.config.dataset ?? "see manifest")}`,
    `questions: ${run.expectedCells}; conc: ${String(run.config.conc ?? "n/a")}`,
    ...(event === "terminal" ? [
      `status: ${run.storedStatus}; new successes ${run.succeededCells}, reused ${run.reusedCells}, failed ${run.failedCells}, interrupted ${run.interruptedCells}`,
      ...(["failed", "interrupted", "blocked"].includes(run.storedStatus)
        ? terminalFailureReasons(run).map(reason => `interruption reason: ${reason}`) : []),
    ] : []),
    `trace: ${run.traceDirectory ?? "not created"}`,
    ...(publication ? [`publication record: ${publication}`] : []),
    "Success means the answer could be parsed, not that the forecast is correct; raw-format and reviewed scores are kept separately.",
  ].join("\n");
}

function compactReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact=value.replace(/\s+/g," ").trim();
  if(!compact) return null;
  return compact.length > 360 ? `${compact.slice(0,357)}…` : compact;
}

/** Extract operator-facing failure causes without exporting prompts or model reasoning. */
export function terminalFailureReasons(run: RegistryRunRow): string[] {
  if(!run.traceDirectory) return ["trace directory not created; cannot extract the interruption reason"];
  const cells=join(run.traceDirectory,"cells");
  if(!existsSync(cells)) return ["the trace records no specific reason"];
  const reasons:string[]=[];
  for(const file of readdirSync(cells).filter(name=>name.endsWith(".jsonl"))) {
    for(const line of readFileSync(join(cells,file),"utf8").split("\n")) {
      if(!line) continue;
      try {
        const event=JSON.parse(line);
        if(event.type === "cell_finished" || event.type === "agent_failed") {
          const reason=compactReason(event.data?.error?.message);
          if(reason && !reasons.includes(reason)) reasons.push(reason);
        }
      } catch { /* Trace verification reports malformed JSON; notification stays best-effort. */ }
    }
  }
  return reasons.length ? reasons.slice(0,3) : ["unstarted cells were interrupted after an upstream cell failed; the trace has no more specific error"];
}

function recordBatched(run: RegistryRunRow, event: "start" | "terminal", message: string) {
  if(!run.traceDirectory) throw new Error("Registered run has no trace archive");
  const path=join(run.traceDirectory,"notifications",`${event}.json`);
  if(!existsSync(path)) json(path,{run_id:run.runId,event,message,status:"batched",
    reason:"Parent continuation controller owns the batch-level notification",recorded_at_utc:new Date().toISOString()});
}

async function deliver(run: RegistryRunRow, event: "start" | "terminal", message: string, sender: Sender) {
  if(!run.traceDirectory) throw new Error("Registered run has no trace archive");
  const path=join(run.traceDirectory,"notifications",`${event}.json`);
  if(existsSync(path)) {
    const receipt=JSON.parse(readFileSync(path,"utf8"));
    if(receipt.status === "sent") return;
    // A timed-out POST may already have arrived. Do not send a duplicate automatically.
    throw new Error(`Feishu delivery needs review before retry: ${path}`);
  }
  const base={run_id:run.runId,event,message,attempted_at_utc:new Date().toISOString()};
  json(path,{...base,status:"sending"});
  try {
    const response=await sender(message);
    json(path,{...base,status:"sent",delivered_at_utc:new Date().toISOString(),response});
  } catch {
    json(path,{...base,status:"delivery_unconfirmed"});
    throw new Error(`Feishu delivery unconfirmed; inspect ${path}`);
  }
}

export async function notifyRegisteredStart(registry: ExperimentRegistry, runId: string, sender: Sender=sendText) {
  const run=registry.getRun(runId);
  if(!run || run.storedStatus!=="running") throw new Error("Start notice requires a running registry entry");
  const bridge=projectEnv("FABENCH_REGISTERED_RUN_FILE");
  if(bridge) json(bridge,{run_id:runId,registry_path:registry.path,trace_directory:run.traceDirectory});
  if(batchChildNotice()) return recordBatched(run,"start",registeredMessage(run,"start"));
  await deliver(run,"start",registeredMessage(run,"start"),sender);
}

export async function publishRegisteredRun(registry: ExperimentRegistry, runId: string, sender: Sender=sendText) {
  const run=registry.getRun(runId);
  if(!run || !["completed","failed","interrupted","blocked"].includes(run.storedStatus))
    throw new Error("Only terminal registry runs can be published");
  if(!run.traceDirectory) throw new Error("Run has no trace directory");
  const path=join(run.traceDirectory,"publication.json");
  if(!existsSync(path)) {
    const manifestPath=join(run.traceDirectory,"manifest.json");
    const manifest=JSON.parse(readFileSync(manifestPath,"utf8"));
    if(manifest.run_id!==runId || manifest.status==="running") throw new Error("Trace is not finalized for this run");
    const files=["manifest.json","cells.jsonl","predictions.jsonl","repair-summary.json","samples.json","sample-results.json","environment-check.json","artifact-inventory.json"].filter(f=>existsSync(join(run.traceDirectory!,f)));
    const publication={schema_version:"raven.run-publication.v1",published_at_utc:new Date().toISOString(),
      run_id:runId,tag:run.tag,owner:run.owner,status:run.storedStatus,
      counts:{expected:run.expectedCells,success:run.succeededCells,reused:run.reusedCells,failed:run.failedCells,interrupted:run.interruptedCells},
      config:run.config,trace_directory:run.traceDirectory,
      files:files.map(file=>({path:join(run.traceDirectory!,file),sha256:sha256(readFileSync(join(run.traceDirectory!,file)))})),
      scope:"Per-run artifact publication; not a claim of inclusion in a different dataset's leaderboard."};
    json(path,publication);
  }
  const message=registeredMessage(run,"terminal",path);
  if(batchChildNotice()) recordBatched(run,"terminal",message);
  else await deliver(run,"terminal",message,sender);
  return path;
}

async function main() {
  const bridge=process.argv[2];
  if(!bridge || !existsSync(bridge)) throw new Error("No registered run receipt; no completed-run notice sent");
  const info=JSON.parse(readFileSync(bridge,"utf8"));
  const registry=new ExperimentRegistry(info.registry_path);
  try {console.log(await publishRegisteredRun(registry,info.run_id));} finally {registry.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
