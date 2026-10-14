/** Offline, provenance-preserving interpretation. This program never calls a model. */
import {readFileSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {ExperimentRegistry,experimentCodeIdentity,type ConfiguredRegistryRun,type RegistryRunRow,type ReusedRegistryCell} from "./registry.js";
import {TraceArchive, sha256, sha256Json, verifyTraceArchive} from "../tracing/trace-archive.js";
import {parseForecastResponse, type ForecastResponse} from "../predictors/forecast-response.js";
import {normalizeForecastResponse, FORECAST_NORMALIZATION_POLICY} from "../predictors/normalize-forecast.js";
import {notifyRegisteredStart, publishRegisteredRun} from "./registered-run-lifecycle.js";
import {buildJevRequest,decodeJevResponse,JEV_MODEL,JEV_POLICY,JEV_REVIEW_POLICY} from "../llm/jev.js";
import { projectEnv } from "../env-names.js";

interface Review {
  question_id: string; raw_sha256: string; reviewer: string; reason: string;
  evidence_quotes: string[]; answer: ForecastResponse;
}
export function reviewedForecast(raw: string, unit: string|null, review: Review): ForecastResponse {
  if(sha256(raw)!==review.raw_sha256 || !review.reviewer.trim() || !review.reason.trim() ||
      !review.evidence_quotes.length || review.evidence_quotes.some(q=>!q.trim() || !raw.includes(q)))
    throw new Error("Review hash, author, reason or verbatim evidence mismatch");
  return parseForecastResponse(JSON.stringify(review.answer),unit);
}
/** Typed reviews may only reproduce an existing event value and the fixed bin-median rule. */
export function reviewedJevForecast(raw:string,prompt:string,unit:string|null,review:Review):ForecastResponse {
  const answer=reviewedForecast(raw,unit,review);
  const expected=decodeJevResponse(JSON.parse(raw),buildJevRequest({system:"Reviewed historical forecast",prompt}),JEV_REVIEW_POLICY).answer;
  if(sha256Json(answer)!==sha256Json(expected))throw new Error("Jev review cannot change a native event probability or derived median");
  return answer;
}
const readJson=(p:string)=>JSON.parse(readFileSync(p,"utf8"));
const readLines=(p:string):any[]=>readFileSync(p,"utf8").split("\n").filter(x=>x.trim()).map(x=>JSON.parse(x));
interface RepairPlan {
  source_run_id: string; registry_path: string; questions_file: string;
  questions_sha256: string; results_dir: string; tag: string;
  reviews?: Review[]; replacements?: {question_id:string;run_id:string;review?:Review}[];
  retain_missing_answers?: {question_id:string;reason:string}[];
  selection?: {arm:string;question_ids:string[]};
}

/** Keep a missing source answer visible; never exclude an existing forecast from scoring. */
export function validateRetainedMissing(raw:string, row:{question_id:string;status:string}, item:{question_id:string;reason:string}):void {
  if(row.status!=="failed" || raw.trim() || item.question_id!==row.question_id || !item.reason?.trim())
    throw new Error("Only an empty failed source answer may be explicitly retained as missing");
}

export function interpretRetryForecast(raw:string,unit:string|null,review?:Review) {
  if(review) {
    let strict=false;try {parseForecastResponse(raw,unit);strict=true;} catch {}
    if(strict) throw new Error("Retry review cannot override a strict success");
    return {answer:reviewedForecast(raw,unit,review),strict:false,corrections:["retry_missing_answer","evidence_bound_review"]};
  }
  const result=normalizeForecastResponse(raw,unit);
  return {...result,corrections:["retry_missing_answer",...result.corrections]};
}

/** Empty failed outputs need explicit replacement or retention in the derived run. */
export function repairRawFinal(events:any[],row:any,allowMissingFailed=false):string {
  const done=events.find(e=>e.type==="agent_finished");
  const fail=events.find(e=>e.type==="agent_failed");
  const last=events.filter(e=>e.type==="assistant_message").at(-1);
  const raw=done?.data.final_answer || fail?.data.partial_final_answer || row.final_answer || last?.data.content;
  if(typeof raw==="string" && raw.trim()) return raw;
  if(row.status==="failed" && row.condition?.model===`jev:${JEV_MODEL}` && row.condition?.harness===JEV_POLICY.version) {
    // A valid typed probability exists even when no synthetic assistant answer
    // was returned after strict distribution validation. Select the LAST response,
    // never by outcome or probability. Its exact body must be evidence-reviewed.
    const transport=events.filter(e=>e.type==="llm_transport" && e.data?.event?.type==="jev_response").at(-1)?.data.event.data;
    if(transport?.status===200 && typeof transport.body==="string" && transport.body.trim())return transport.body;
  }
  if(allowMissingFailed && row.status!=="success") return "";
  throw new Error(`Missing raw final: ${row.question_id}`);
}

/** Resolve successes recorded as reused by the source run, not today's canonical winners. */
export function resolveRepairSources(source: ConfiguredRegistryRun, runs: RegistryRunRow[], reused: ReusedRegistryCell[],
  verifyArchive: (directory: string)=>void, selection?:{arm:string;question_ids:string[]}) {
  const originalSelected=source.config.selected_question_ids as string[];
  const selected=selection?.question_ids??originalSelected;
  const conditions=(source.config.conditions as any[]).filter(c=>!selection||c.arm===selection.arm);
  if(conditions.length!==1 || !selected.length || new Set(selected).size!==selected.length ||
      selected.some(id=>!originalSelected.includes(id))) throw new Error("Invalid repair selection");
  const condition=conditions[0];
  const allRows=readLines(join(source.traceDirectory!,"cells.jsonl"));
  if(new Set(originalSelected).size!==originalSelected.length || allRows.some(row=>!originalSelected.includes(row.question_id)) ||
      new Set(allRows.map(row=>`${row.arm}/${row.question_id}`)).size!==allRows.length)
    throw new Error("Source has duplicate or unexpected questions");
  const sourceRows=selection?allRows.filter(row=>row.arm===selection.arm&&selected.includes(row.question_id)):allRows;
  verifyArchive(source.traceDirectory!);
  const byId=new Map(sourceRows.map(row=>[row.question_id,{row,directory:source.traceDirectory!,runId:source.runId,reused:false}]));
  for(const receipt of reused) {
    if(selection && (receipt.arm!==selection.arm||!selected.includes(receipt.questionId))) continue;
    if(!selected.includes(receipt.questionId) || byId.has(receipt.questionId) ||
        receipt.conditionId!==condition.condition_id || receipt.arm!==condition.arm)
      throw new Error("Invalid or duplicate source reuse receipt");
    const origin=runs.find(run=>run.runId===receipt.sourceRunId);
    if(!origin?.traceDirectory || !["completed","failed","interrupted"].includes(origin.storedStatus))
      throw new Error("Reused origin must be a terminal registered run");
    verifyArchive(origin.traceDirectory);
    const matches=readLines(join(origin.traceDirectory,"cells.jsonl")).filter(row=>
      row.question_id===receipt.questionId && row.arm===receipt.arm);
    const row=matches[0];
    if(matches.length!==1 || row.status!=="success" || row.condition?.condition_id!==receipt.conditionId ||
        !Number.isFinite(receipt.probability) || row.probability!==receipt.probability || !receipt.tracePath ||
        resolve(origin.traceDirectory,row.trace_file)!==resolve(receipt.tracePath))
      throw new Error("Reused source trace does not match its historical receipt");
    byId.set(receipt.questionId,{row,directory:origin.traceDirectory,runId:origin.runId,reused:true});
  }
  if(byId.size!==selected.length) throw new Error("Missing source trace without a registered reuse receipt");
  return byId;
}

async function main() {
  const planPath=process.argv[2];
  if(!planPath) throw new Error("Usage: repair-forecast-run.ts plan.json [--apply]");
  const plan=readJson(planPath) as RepairPlan;
  const apply=process.argv.includes("--apply");
  const questionBytes=readFileSync(plan.questions_file);
  if(sha256(questionBytes)!==plan.questions_sha256) throw new Error("Question file hash mismatch");
  const questions=new Map(readLines(plan.questions_file).map(q=>[q.id,q]));
  const registry=new ExperimentRegistry(plan.registry_path);
  let archive: TraceArchive|undefined;
  let activeRunId: string|undefined;
  try {
    const runs=registry.listRuns();
    const source=registry.getRun(plan.source_run_id);
    if(!source?.traceDirectory || !["completed","failed","interrupted"].includes(source.storedStatus))
      throw new Error("Source must be a terminal, registered run with traces");
    const conditions=(source.config.conditions as any[]).filter(c=>!plan.selection||c.arm===plan.selection.arm);
    if(conditions.length!==1) throw new Error("Repair one arm per run");
    const originalCondition=conditions[0];
    const normalizationPolicy=originalCondition.harness===JEV_POLICY.version?JEV_REVIEW_POLICY:FORECAST_NORMALIZATION_POLICY;
    const selected=plan.selection?.question_ids??source.config.selected_question_ids as string[];
    const seenArchives=new Map<string,string>();
    function verifyArchive(directory:string) {
      if(seenArchives.has(directory)) return;
      const check=verifyTraceArchive(directory);
      if(!check.ok) throw new Error(`Source archive integrity failed: ${directory}: ${JSON.stringify(check)}`);
      seenArchives.set(directory,sha256(readFileSync(join(directory,"manifest.json"))));
    }
    const byId=resolveRepairSources(source,runs,registry.getRunReusedCells(source.runId),verifyArchive,plan.selection);
    function readRaw(row:any,directory:string,q:any,allowMissingFailed=false) {
      const tracePath=join(directory,row.trace_file);
      const bytes=readFileSync(tracePath);
      const events=bytes.toString("utf8").split("\n").filter(Boolean).map(x=>JSON.parse(x));
      const initial=events.find(e=>e.type==="agent_started")?.data.initial_messages;
      if(!initial?.some((m:any)=>m.role==="user" && m.content===q.prompt))
        throw new Error(`Question prompt mismatch: ${q.id}`);
      if(row.condition.condition_id!==originalCondition.condition_id) throw new Error("Generation condition mismatch");
      const raw=repairRawFinal(events,row,allowMissingFailed);
      return {raw,trace_path:tracePath,trace_sha256:sha256(bytes),raw_sha256:sha256(raw)};
    }
    const reviews=new Map((plan.reviews??[]).map(r=>[r.question_id,r]));
    const replacements=new Map((plan.replacements??[]).map(r=>[r.question_id,r]));
    const retained=new Map((plan.retain_missing_answers??[]).map(r=>[r.question_id,r]));
    if(reviews.size!==(plan.reviews??[]).length || replacements.size!==(plan.replacements??[]).length || retained.size!==(plan.retain_missing_answers??[]).length)
      throw new Error("Duplicate review/replacement IDs");
    for(const id of [...reviews.keys(),...replacements.keys(),...retained.keys()]) if(!selected.includes(id)) throw new Error(`Unknown override ${id}`);
    for(const id of retained.keys()) if(reviews.has(id)||replacements.has(id)) throw new Error(`Missing retention conflicts with another override: ${id}`);
    const prepared=selected.map(id=>{
      const q=questions.get(id), origin=byId.get(id);
      if(!q || !origin) throw new Error(`Missing question ${id}`);
      const original=origin.row;
      const unit=q.numeric_target_unit ?? null;
      const originalRaw=readRaw(original,origin.directory,q,replacements.has(id)||retained.has(id));
      let chosen=originalRaw,sourceRunId=origin.runId;
      let originalStrict=false;
      try {parseForecastResponse(originalRaw.raw,unit);originalStrict=true;} catch { /* Kept as strict failure. */ }
      const keepMissing=retained.get(id);
      if(keepMissing) {
        validateRetainedMissing(originalRaw.raw,original,keepMissing);
        return {id,q,original_status:original.status,original_strict:false,source_run_id:origin.runId,
          original_source_run_id:origin.runId,original_reused:origin.reused,original_source:originalRaw,chosen:originalRaw,
          missing:true as const,missing_reason:keepMissing.reason,corrections:["retain_missing_answer"]};
      }
      let result;
      const review=reviews.get(id);
      if(review) {
        if(originalStrict || replacements.has(id)) throw new Error("Review cannot override a strict success or retry");
        result={answer:normalizationPolicy===JEV_REVIEW_POLICY?reviewedJevForecast(chosen.raw,q.prompt,unit,review):reviewedForecast(chosen.raw,unit,review),strict:false,corrections:["evidence_bound_review",...(normalizationPolicy===JEV_REVIEW_POLICY?[JEV_REVIEW_POLICY]:[])]};
      } else {
        try {result=normalizeForecastResponse(chosen.raw,unit);} catch(error) {
          const replacement=replacements.get(id);
          if(!replacement) throw new Error(`${id}: ${String(error)}`);
          const retryId=replacement.run_id;
          if(original.status==="success") throw new Error("Cannot replace successful original response");
          const retry=runs.find(r=>r.runId===retryId);
          if(!retry?.traceDirectory || !["completed","failed","interrupted"].includes(retry.storedStatus)) throw new Error("Retry is not terminal");
          verifyArchive(retry.traceDirectory);
          const retryRows=readLines(join(retry.traceDirectory,"cells.jsonl")).filter(r=>r.question_id===id && r.arm===original.arm);
          if(retryRows.length!==1 || !["success","failed"].includes(retryRows[0].status)) throw new Error("No unique terminal retry response");
          chosen=readRaw(retryRows[0],retry.traceDirectory,q);sourceRunId=retryId;
          if(replacement.review && replacement.review.question_id!==id) throw new Error("Retry review question mismatch");
          result=interpretRetryForecast(chosen.raw,unit,replacement.review);
        }
        if(replacements.has(id) && sourceRunId===origin.runId) throw new Error(`Unnecessary retry substitution: ${id}`);
      }
      return {id,q,original_status:original.status,original_strict:originalStrict,source_run_id:sourceRunId,
        original_source_run_id:origin.runId,original_reused:origin.reused,
        original_source:originalRaw,chosen,review:review??null,replacement_review:replacements.get(id)?.review??null,missing:false as const,...result};
    });
    const count=(test:(x:typeof prepared[number])=>boolean)=>prepared.filter(test).length;
    const summary={schema_version:"raven.forecast-repair-summary.v1",source_run_id:source.runId,
      selection:plan.selection??null,source_expected_cells:source.expectedCells,
      expected:prepared.length,original_strict_success:count(x=>x.original_strict),original_strict_failed:count(x=>!x.original_strict),
      normalized_original:count(x=>!x.missing && !x.original_strict && !x.review && x.source_run_id===x.original_source_run_id),
      reviewed_original:count(x=>!x.missing && !!x.review),retry_substitutions:count(x=>x.source_run_id!==x.original_source_run_id),
      reviewed_retries:count(x=>!x.missing && !!x.replacement_review),
      reused_original:count(x=>x.original_reused),retained_missing_answers:[...retained.values()],
      valid:count(x=>!x.missing),numeric:count(x=>!x.missing && x.answer.numeric_forecast!==null),event_only:count(x=>!x.missing && x.answer.numeric_forecast===null),
      new_model_calls:0,policy:normalizationPolicy};
    if(!apply) {console.log(JSON.stringify({dry_run:true,...summary},null,2));return;}
    if(!projectEnv("FABENCH_FEISHU_WEBHOOK_URL")) throw new Error("Registered shared repair requires Feishu configuration before apply");
    const codeIdentity=experimentCodeIdentity();
    const interpretation={policy:normalizationPolicy,code_fingerprint_sha256:codeIdentity.source_fingerprint_sha256,plan_sha256:sha256(readFileSync(planPath)),source_run_id:source.runId};
    const condition={...originalCondition,interpretation,condition_id:`raven-condition:${sha256Json({originalCondition,interpretation}).slice(0,16)}`};
    const config={...source.config,selected_question_ids:selected,compare:condition.arm,generation_code_identity:source.config.code_identity,code_identity:codeIdentity,runAtUtc:new Date().toISOString(),execution_mode:"postprocess",new_model_calls:0,conc:null,conditions:[condition],
      interpretation,source_run_ids:[...new Set(prepared.map(x=>x.source_run_id))],source_registry:source.config.registry,
      registry:null,repair_plan:plan,repair_summary:summary};
    const preflight=registry.prepareRun({tag:plan.tag,experimentKey:sha256Json(condition),expectedCells:prepared.length,config,
      cells:prepared.map(x=>({conditionId:condition.condition_id,questionId:x.id,arm:condition.arm}))});
    activeRunId=preflight.runId;
    if(preflight.blocked.length) {activeRunId=undefined;throw new Error("Repair cells are already claimed");}
    if(preflight.reused.length) {registry.finishRun(preflight.runId,"completed");activeRunId=undefined;console.log(`Already registered: ${preflight.reused[0]!.sourceRunId}`);return;}
    archive=new TraceArchive({runId:preflight.runId,resultsDir:plan.results_dir,tag:plan.tag,expectedCells:prepared.length,run:config});
    registry.markRunning(preflight.runId,archive.directory);
    await notifyRegisteredStart(registry,preflight.runId);
    const predictions=[];
    for(const item of prepared) {
      registry.markCellRunning(preflight.runId,condition.condition_id,item.id);
      const cell=archive.beginCell({question_id:item.id,arm:condition.arm,condition,question:item.q.question_en,as_of:item.q.as_of_date});
      if(item.missing) {
        const error={name:"SourceMissingAnswer",message:item.missing_reason};
        cell.record({type:"forecast_missing",data:{source_run_id:item.source_run_id,original_run_id:source.runId,
          original_source:item.original_source,original_status:item.original_status,reason:item.missing_reason,
          policy:normalizationPolicy,corrections:item.corrections}});
        cell.finish("failed",{source_run_id:item.source_run_id,original_strict:false,corrections:item.corrections,error});
        registry.recordCell(preflight.runId,{conditionId:condition.condition_id,questionId:item.id,arm:condition.arm,
          status:"failed",probability:null,tracePath:cell.path,summary:{source_run_id:item.source_run_id,error}});
        continue;
      }
      cell.record({type:"forecast_interpreted",data:{source_run_id:item.source_run_id,original_run_id:source.runId,
        original_source_run_id:item.original_source_run_id,original_reused:item.original_reused,
        source:item.chosen,original_source:item.original_source,original_status:item.original_status,
        original_strict:item.original_strict,policy:normalizationPolicy,corrections:item.corrections,
        review:item.review,replacement_review:item.replacement_review}});
      const answer={question_id:item.id,arm:condition.arm,probability:item.answer.probability_yes,
        numeric_forecast:item.answer.numeric_forecast,final_answer:JSON.stringify(item.answer),
        original_strict:item.original_strict,source_run_id:item.source_run_id,corrections:item.corrections};
      cell.record({type:"agent_finished",data:{final_answer:answer.final_answer,execution_mode:"postprocess"}});
      cell.finish("success",answer);
      registry.recordCell(preflight.runId,{conditionId:condition.condition_id,questionId:item.id,arm:condition.arm,status:"success",
        probability:item.answer.probability_yes,tracePath:cell.path,summary:answer});
      predictions.push({id:item.id,...item.answer,original_strict:item.original_strict,source_run_id:item.source_run_id,
        source_trace:item.chosen.trace_path,corrections:item.corrections});
    }
    // Re-check immutable source manifests after interpretation; raw event hashes are also archived above.
    for(const [dir,hash] of seenArchives) if(sha256(readFileSync(join(dir,"manifest.json")))!==hash) throw new Error("Source changed during repair");
    writeFileSync(join(archive.directory,"predictions.jsonl"),predictions.map(x=>JSON.stringify(x)).join("\n")+"\n",{mode:0o640});
    writeFileSync(join(archive.directory,"repair-summary.json"),JSON.stringify({...summary,run_id:preflight.runId},null,2)+"\n",{mode:0o640});
    const terminalStatus=retained.size?"failed":"completed";
    archive.finish(terminalStatus,summary);
    if(!verifyTraceArchive(archive.directory).ok) throw new Error("Derived archive verification failed");
    registry.finishRun(preflight.runId,terminalStatus,retained.size?"Original source contains explicitly retained missing answers":undefined);activeRunId=undefined;
    const publication=await publishRegisteredRun(registry,preflight.runId);
    console.log(JSON.stringify({...summary,run_id:preflight.runId,publication},null,2));
  } catch(error) {
    if(activeRunId) {archive?.finish("failed",{error:String(error)});registry.finishRun(activeRunId,"failed",String(error));}
    throw error;
  } finally {registry.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
