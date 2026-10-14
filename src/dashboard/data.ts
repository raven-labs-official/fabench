import { comparisonKey } from "../analysis/comparison-policy.js";
export { comparisonKey } from "../analysis/comparison-policy.js";
import { commonLabels } from "../analysis/selection.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, statSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { brierCI, brierIndex } from "../scoring/bootstrap.js";
import { expectedCalibrationError, logLoss } from "../scoring/brier.js";
import { matchesRunningProcess } from "../process-identity.js";
import { isJsonObject, parseRegistryObject } from "../experiments/registry-json.js";
import { readRunResources } from "./resources.js";
import { SHARED_ROOT } from "../path-config.js";

type Obj = Record<string, any>;
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
function parseRecord(raw: string): Obj | null {
  try {
    return parseRegistryObject(raw, "archive record");
  } catch {
    return null;
  }
}
interface RunConfigRead {
  value: Obj | null;
  error: "invalid_config" | null;
}
function readRunConfig(row: Obj): RunConfigRead {
  try {
    const value = parseRegistryObject<Obj>(row.config_json, `${row.run_id} config_json`);
    if (value.conditions !== undefined
      && (!Array.isArray(value.conditions) || !value.conditions.every(isJsonObject))) {
      throw new Error("Invalid run conditions");
    }
    return { value, error: null };
  } catch {
    return { value: null, error: "invalid_config" };
  }
}
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const prob = (x: unknown): x is number => num(x) && x >= 0 && x <= 1;
const active = ["running", "claimed", "sleeping"];
export function identityMatches(r: Obj): boolean {
  return matchesRunningProcess({
    pid: r.pid,
    host: r.host,
    startedTicks: r.process_started_ticks,
    bootId: r.boot_id,
  });
}
export function effectiveState(r: Obj, matches = identityMatches(r), now = Date.now()) {
  const heartbeatAge = Math.max(0, (now - Date.parse(r.last_heartbeat_utc)) / 1000);
  return { status: active.includes(r.status) && heartbeatAge > 120 && !matches ? "stale" : r.status,
    storedStatus: r.status, heartbeatAge, processMatches: matches,
    livenessWarning: active.includes(r.status) && (heartbeatAge > 120 || !matches) };
}
// Defense in depth: only explicitly projected data leaves this module. No raw config,
// exception text, trace, prompt, rationale, or provider response is returned.
export function safeText(x: unknown, max = 500): string | null {
  if (typeof x !== "string") return null;
  if (/https?:\/\/|sk-[a-zA-Z0-9]|Bearer\s|webhook|api[_-]?key|BEGIN .*PRIVATE KEY/i.test(x)) return "[redacted]";
  return x.slice(0, max);
}
const scalar = (x: unknown): any => typeof x === "string" ? safeText(x) : num(x) || typeof x === "boolean" ? x : null;
function pick(o: Obj | undefined, keys: string[]) { return Object.fromEntries(keys.map(k => [k, scalar(o?.[k])])); }
export function metrics(cells: Obj[]) {
  const valid = cells.filter(c => prob(c.probability) && (c.outcome === 0 || c.outcome === 1));
  if (!valid.length) return { n:0, brier:null, brierIndex:null, ece:null, logLoss:null, accuracy:null, ci:null };
  const p = valid.map(c=>c.probability as number), y = valid.map(c=>c.outcome as 0|1);
  const ci = brierCI(p,y,400);
  return {n:valid.length,brier:ci.point,brierIndex:brierIndex(ci.point),ci:[ci.lo,ci.hi],
    ece:expectedCalibrationError(p,y),logLoss:logLoss(p,y),accuracy:valid.filter(c=>(c.probability>=0.5?1:0)===c.outcome).length/valid.length};
}
export class DashboardData {
  private db: DatabaseSync;
  private snapshotCache: {at:number; value:Obj} | null = null;
  private details = new Map<string,{at:number; value:Obj}>();
  constructor(readonly registryPath: string) {
    this.db = new DatabaseSync(registryPath, {readOnly:true});
    this.db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=250;");
  }
  close() { this.db.close(); }
  private rows(): Obj[] { return this.db.prepare("SELECT * FROM runs ORDER BY started_at_utc DESC").all() as Obj[]; }
  private cells(id: string): Obj[] {
    return this.db.prepare("SELECT question_id,condition_id,arm,status,probability,source_run_id,updated_at_utc FROM run_cells WHERE run_id=?").all(id) as Obj[];
  }
  private publicRun(r: Obj, config = readRunConfig(r)) {
    const c = config.value;
    const conditions: Obj[] = c?.conditions ?? [];
    const mode = c === null ? null : c.execution_mode === "postprocess" ? "reviewed" : "strict";
    return {
      id: r.run_id,
      tag: safeText(r.tag),
      owner: safeText(r.owner),
      model: safeText(c?.llm),
      ...effectiveState(r),
      expected: r.expected_cells,
      success: r.succeeded_cells,
      reused: r.reused_cells,
      failed: r.failed_cells,
      interrupted: r.interrupted_cells,
      done: r.succeeded_cells + r.reused_cells + r.failed_cells + r.interrupted_cells,
      started: r.started_at_utc,
      updated: r.last_heartbeat_utc,
      finished: r.finished_at_utc,
      elapsedSeconds: Math.max(0, (Date.parse(r.finished_at_utc ?? new Date().toISOString()) - Date.parse(r.started_at_utc)) / 1000),
      questionSet: safeText(c?.question_set_id ?? c?.question_set?.question_set_id),
      harness: safeText(c?.harness),
      arms: conditions.map(x => safeText(x.arm)).filter(Boolean),
      mode,
      sourceRun: safeText(c?.interpretation?.source_run_id),
      groups: c ? conditions.map(x => ({ arm: safeText(x.arm), key: comparisonKey(c, x) })) : [],
      metadataError: config.error,
      errorCategory: r.error
        ? /failure_rate_exceeded/i.test(r.error) ? "failure_rate_exceeded" : "run_failed; see protected archive"
        : null,
    };
  }
  snapshot() {
    if (this.snapshotCache && Date.now()-this.snapshotCache.at<15000) return this.snapshotCache.value;
    const started=Date.now(), runs=this.rows().map(r=>this.publicRun(r));
    const value={generatedAt:new Date().toISOString(),refreshSeconds:15,runs,queryMs:Date.now()-started};
    this.snapshotCache={at:Date.now(),value}; return value;
  }
  private allowedFile(path: string, max = 32*1024*1024): string | null {
    try { const p=realpathSync(path);
      if (!p.startsWith(SHARED_ROOT+"/") || /\/(config|blobs)\//.test(p) || /\.env/.test(p) || statSync(p).size>max) return null;
      return readFileSync(p,"utf8");
    } catch { return null; }
  }
  private index(r:Obj): Map<string,Obj> {
    const out=new Map<string,Obj>();
    if (!r.trace_directory) return out;
    const data=this.allowedFile(join(r.trace_directory,"cells.jsonl"));
    if (!data) return out;
    for (const line of data.split("\n")) {
      const row = parseRecord(line);
      if (typeof row?.question_id === "string" && typeof row.arm === "string")
        out.set(row.question_id + "|" + row.arm, row);
    }
    return out;
  }
  private labels(c:Obj) {
    const args=c.environment_admission?.conditions ?? {};
    const file=args["grading-file"];
    const expected=c.question_set?.grading_file_sha256;
    if (typeof file!=="string" || !expected) return null;
    const raw=this.allowedFile(file,8*1024*1024);
    if (!raw || createHash("sha256").update(raw).digest("hex")!==expected) return null;
    const labels = new Map<string, Obj>();
    for (const line of raw.trim().split("\n")) {
      const row = parseRecord(line);
      if (typeof row?.id !== "string") return null;
      labels.set(row.id, row);
    }
    return labels;
  }
  detail(id: string) {
    const cached=this.details.get(id);
    if(cached && Date.now()-cached.at<60000) return cached.value;
    const r=this.db.prepare("SELECT * FROM runs WHERE run_id=?").get(id) as Obj|undefined;
    if(!r) return null;
    const config = readRunConfig(r), c = config.value;
    const ownIndex = this.index(r), labels = c ? this.labels(c) : null;
    const sourceIndexes = new Map<string, Map<string, Obj>>();
    const cells=this.cells(id).map(cell=>{
      let index=ownIndex;
      if(cell.status==="reused" && cell.source_run_id!==id) {
        if(!sourceIndexes.has(cell.source_run_id)) {
          const source=this.db.prepare("SELECT trace_directory FROM runs WHERE run_id=?").get(cell.source_run_id) as Obj|undefined;
          sourceIndexes.set(cell.source_run_id,source?this.index(source):new Map());
        } index=sourceIndexes.get(cell.source_run_id)!;
      }
      const raw=index.get(cell.question_id+"|"+cell.arm), label=labels?.get(cell.question_id);
      const settled=label ? !!label.resolution_date && Date.parse(label.resolution_date)<=Date.now() : raw?.ground_truth===0 || raw?.ground_truth===1;
      const outcome=settled?(label?.resolution_result ?? raw?.ground_truth):null;
      const forecast=raw?.numeric_forecast, actual=label?.numeric_result;
      // Refusal detection uses archived error/answer only, never returns either text.
      let answer = String(raw?.final_answer ?? "");
      if (cell.status==="failed" && !answer && typeof raw?.trace_file==="string" && r.trace_directory) {
        const file=resolve(r.trace_directory,raw.trace_file);
        if(file.startsWith(resolve(r.trace_directory)+"/cells/")) {
          const events=this.allowedFile(file,4*1024*1024);
          if(events) for(const line of events.split("\n")) {
            const event=parseRecord(line);
            if(event?.type==="assistant_message" && typeof event.data?.content==="string") answer=event.data.content;
          }
        }
      }
      const refusal=cell.status==="failed" && !answer ? null : cell.status==="failed" && /refus|cannot|can.t|unable to|won.t|not (?:able|allowed)|political forecasting|拒绝|拒答/i.test(answer);
      return {questionId:safeText(cell.question_id),arm:safeText(cell.arm),status:cell.status,
        probability:["success","reused"].includes(cell.status)&&prob(cell.probability)?cell.probability:null,
        outcome:outcome===0||outcome===1?outcome:null,sourceRun:safeText(cell.source_run_id),refusal,
        numericForecast:num(forecast?.value)?forecast.value:null,unit:safeText(forecast?.unit),
        numericActual:num(actual)?actual:num(actual?.value)?actual.value:null,
        // Numeric grading units must be present and agree before an error can be shown.
        numericError:settled&&["success","reused"].includes(cell.status)&&num(forecast?.value)&&num(actual?.value)&&actual?.unit===forecast?.unit?Math.abs(forecast.value-actual.value):null,
        updated:cell.updated_at_utc};
    });
    let systemPromptSampleSha256=null, promptSampleQuestion=null;
    const sample=[...ownIndex.values()].find(x=>typeof x.trace_file==="string");
    if(sample && r.trace_directory) {
      const file=resolve(r.trace_directory,sample.trace_file);
      if(file.startsWith(resolve(r.trace_directory)+"/cells/")) {
        const raw=this.allowedFile(file,4*1024*1024);
        if(raw) for(const line of raw.split("\n")) {
          const event=parseRecord(line);
          if(event?.type==="agent_started" && Array.isArray(event.data?.initial_messages)) {
            const system=event.data.initial_messages.filter((m:unknown)=>isJsonObject(m) && m.role==="system");
            if(system.length){systemPromptSampleSha256=hash(system);promptSampleQuestion=safeText(sample.question_id);}
            break;
          }
        }
      }
    }
    const conditions:Obj[]=c?.conditions??[];
    const metricsByArm=conditions.map(cond=>({arm:safeText(cond.arm),...metrics(cells.filter(x=>x.arm===cond.arm))}));
    const numericByUnit=[...new Set(cells.filter(x=>x.numericError!==null).map(x=>x.unit))].map(unit=>{
      const xs=cells.filter(x=>x.unit===unit&&x.numericError!==null);return {unit,n:xs.length,mae:xs.reduce((s,x)=>s+x.numericError!,0)/xs.length};
    });
    const resources = c
      ? readRunResources({runId:id,tag:r.tag,traceDirectory:r.trace_directory}, path => this.allowedFile(path))
      : {status:"unavailable" as const,rows:[]};
    const subscription=c?.llm_client?.pricing?.usd_cost_known===false || /^(codex|claude):/.test(c?.llm??"");
    const value={...this.publicRun(r,config),cells,metrics:metricsByArm,numericByUnit,
      refusalCount:cells.filter(x=>x.refusal).length,refusalCoverage:cells.filter(x=>x.status==="failed"&&x.refusal!==null).length,refusalUnknown:cells.filter(x=>x.refusal===null).length,
      labelsSource:labels?"hash-verified grading file":"archived ground_truth; numeric grading unavailable",
      numericNote:"Brier scores the binary event probability, including numeric questions with a binary event. Numeric MAE is separate, requires matching recorded units, and is never pooled across units.",
      parameters:c ? {
        ...pick(c,["reasoning_mode","thinking_effort","requested_thinking_effort","maxToolCalls","maxResultsPerSearch","fetchChars","conc","retrievalProfile","searchProviderResolved","leakFilter","leakFilterPolicy","reviewThinking"]),
        reasoningSource:safeText(c.reasoning?.source),
        questionFileSha256:safeText(c.question_set?.file_sha256),gradingFileSha256:safeText(c.question_set?.grading_file_sha256),
        promptArtifactSha256:safeText(c.question_set?.file_sha256),systemPromptSha256:safeText(c.system_prompt_sha256),systemPromptSampleSha256,promptSampleQuestion,
        selectedQuestionsSha256:safeText(c.selected_questions_sha256),
        commit:safeText(c.code_identity?.git_commit),sourceSha256:safeText(c.code_identity?.source_fingerprint_sha256),
        interpretationPolicy:safeText(c.interpretation?.policy),
        conditions:conditions.map(x=>pick(x,["condition_id","arm","protocol_version","harness","response_parse_policy","reasoning_source","max_tool_calls","max_results_per_search","filter_model","filter_policy","search_provider","search_delivery","search_delivery_mode","date_gate","search_type","budget_scope","max_search_calls","max_fetch_calls","code_fingerprint_sha256","environment_contract_sha256"]))
      } : null,
      costsStatus:resources.status,
      costs:resources.rows.map(x=>({arm:safeText(x.arm),knownUsd:subscription?null:num(x.totalCostUsd)?x.totalCostUsd:null,
        scope:safeText(x.resourceScope),note:subscription?"subscription cost unknown":"model subtotal; unpriced search/Reader/subscription excluded"})),
      scoreUpdatedAt:new Date().toISOString()};
    this.details.set(id,{at:Date.now(),value});return value;
  }
  compare(ids:string[],arm:string) {
    const runs=ids.map(id=>this.detail(id));
    if(runs.some(r=>!r)) throw new Error("Unknown run");
    const keys=runs.map(r=>r!.groups.find((g:Obj)=>g.arm===arm)?.key);
    if(!keys[0] || keys.some(k=>k!==keys[0])) throw new Error("Runs do not share verified dataset, harness and experiment conditions");
    const usable=runs.map(r=>new Map<string,Obj>(r!.cells.filter((x:Obj)=>x.arm===arm&&x.probability!==null&&x.outcome!==null).map((x:Obj)=>[x.questionId,x])));
    const { commonIds: common } = commonLabels(usable as Map<string, {outcome: number | null}>[]);
    const rows=runs.map((r,i)=>({id:r!.id,model:r!.model,tag:r!.tag,mode:r!.mode,expected:r!.cells.filter((x:Obj)=>x.arm===arm).length,
      available:usable[i]!.size,failed:r!.cells.filter((x:Obj)=>x.arm===arm&&["failed","interrupted"].includes(x.status)).length,
      refused:r!.cells.filter((x:Obj)=>x.arm===arm&&x.refusal).length,
      ...metrics(common.map(id=>usable[i]!.get(id)!))})).sort((a,b)=>(a.brier??Infinity)-(b.brier??Infinity));
    const numericRankings=[...new Set(common.map(id=>usable[0]!.get(id)!.unit).filter(Boolean))].map(unit=>{
      const ids=common.filter(id=>usable.every(m=>{const x=m.get(id)!;const first=usable[0]!.get(id)!;return x.unit===unit&&x.numericError!==null&&x.numericActual===first.numericActual;}));
      return {unit,n:ids.length,rows:runs.map((r,i)=>({id:r!.id,model:r!.model,
        mae:ids.length?ids.reduce((sum,id)=>sum+usable[i]!.get(id)!.numericError,0)/ids.length:null})).sort((a,b)=>(a.mae??Infinity)-(b.mae??Infinity))};
    }).filter(g=>g.n>0);
    return {arm,common:common.length,questionIds:common,group:keys[0],rows,numericRankings,
      note:"Ranking uses only identical-label, settled, parseable answers shared by every selected run. Missing answers are excluded, never scored as 0.5. Coverage and failure rates must be read with rank. Small differences do not establish superiority."};
  }
}
