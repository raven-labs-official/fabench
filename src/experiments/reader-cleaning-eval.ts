/** Registered structural-cleaning diagnostics. Samples are documents, never forecast cells. */
import {mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync, chmodSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {userInfo, hostname} from 'node:os';
import {ReaderCleaner, EvidenceStore} from '../../vendor/retrieval-infra/src/index.js';
import {sha256} from '../tracing/trace-archive.js';
import {createLlmClient} from '../llm/benchmark-providers.js';
import {ExperimentRegistry, experimentCodeIdentity} from './registry.js';
import {checkEnvironment} from './environment-check.js';
import {notifyRegisteredStart, publishRegisteredRun} from './registered-run-lifecycle.js';
import {PKG_ROOT} from '../paths.js';
import {SHARED_BENCH_DIR, SHARED_REGISTRY_PATH, SHARED_RESULTS_DIR, SHARED_RUNS_ROOT} from '../path-config.js';
import { projectEnv } from "../env-names.js";

export interface CleaningSample {id:string; document_id:string; checks:{action:'keep'|'drop'; quote:string; reason:string}[]}
export function checkCleaningOutput(body:string, checks:CleaningSample['checks']) {
  return checks.map(check=>({...check, passed:body.includes(check.quote)===(check.action==='keep')}));
}
function save(path:string,value:unknown) {
  const temp=`${path}.${process.pid}.tmp`; writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o640}); renameSync(temp,path);
}
export function validateCleaningSamples(value:unknown): asserts value is {evidence_directory:string;samples:CleaningSample[]} {
  const v=value as any;
  if (!v || typeof v.evidence_directory!=='string' || !Array.isArray(v.samples) || !v.samples.length || v.samples.length>20) throw new Error('Expected 1–20 archived document samples');
  const ids=new Set<string>(), docs=new Set<string>();
  for (const s of v.samples) {
    if (!/^[a-z0-9_-]+$/.test(s.id) || ids.has(s.id) || !/^[a-f0-9]{64}$/.test(s.document_id) || docs.has(s.document_id) || !Array.isArray(s.checks) || !s.checks.length) throw new Error('Invalid or duplicate cleaning sample');
    ids.add(s.id); docs.add(s.document_id);
    for (const c of s.checks) if (!['keep','drop'].includes(c.action) || typeof c.quote!=='string' || !c.quote.trim() || typeof c.reason!=='string' || !c.reason.trim()) throw new Error('Invalid annotated excerpt');
  }
}
async function main() {
  const args=process.argv.slice(2);
  if (args.length!==1) throw new Error('Usage: tools/run-shared-reader-cleaning.sh samples.json');
  if (projectEnv("FABENCH_READER_DIAGNOSTIC_LOCK")!=='1' || projectEnv("FABENCH_SHARED_LIFECYCLE")!=='1') throw new Error('Use the shared diagnostic launcher and its exclusive lock');
  const dir=realpathSync(projectEnv("FABENCH_RESULTS_DIR")!);
  if (!dir.startsWith(SHARED_RESULTS_DIR+'/')) throw new Error('Shared results directory required');
  const model='deepseek:deepseek-flash';
  const admission=checkEnvironment(PKG_ROOT,[],{diagnosticModel:model}); save(join(dir,'environment-check.json'),admission);
  if (!admission.ok) throw new Error(`Environment admission failed: ${admission.checks.filter(c=>!c.ok).map(c=>c.name+': '+c.detail).join('; ')}`);
  const input=JSON.parse(readFileSync(resolve(args[0]!),'utf8')); validateCleaningSamples(input);
  const sourcePath=realpathSync(input.evidence_directory);
  if (!sourcePath.startsWith(SHARED_RUNS_ROOT+'/')) throw new Error('Samples must use archived shared evidence');
  const source=new EvidenceStore(sourcePath);
  const documents=input.samples.map(s=> {
    const d=source.get<{url:string;title:string;body:string;bodySha256:string;provenanceId:string}>(s.document_id);
    if (typeof d.body!=='string' || typeof d.url!=='string' || typeof d.title!=='string' || sha256(d.body)!==d.bodySha256) throw new Error(`Invalid document: ${s.id}`);
    const provenance=source.get<{page:{source:string}}>(d.provenanceId);
    if (provenance.page.source!=='reader') throw new Error(`Sample is not Reader text: ${s.id}`);
    if (s.checks.some(c=>!d.body.includes(c.quote))) throw new Error(`Annotated excerpt absent from original: ${s.id}`);
    return d;
  });
  save(join(dir,'samples.json'),input);
  // The launcher serializes diagnostic runs. Content/configuration caches then prevent
  // repeated paid calls for already completed document samples, across owners and tags.
  const cacheRoot=join(SHARED_BENCH_DIR,'reader-cleaning-cache');
  const artifacts=new EvidenceStore(join(cacheRoot,'evidence'));
  const client=createLlmClient('deepseek','deepseek-flash');
  const cleaner=new ReaderCleaner(client,artifacts,{cacheDirectory:join(cacheRoot,'entries')});
  for (const path of [cacheRoot,artifacts.directory,join(cacheRoot,'entries')]) if ((statSync(path).mode & 0o7777)!==0o2770) chmodSync(path,0o2770);
  const configuration=cleaner.configuration(), code=experimentCodeIdentity(PKG_ROOT);
  const conditionId='reader-cleaning:'+sha256(JSON.stringify(configuration));
  const config={execution_mode:'reader-cleaning',model,llm:model,conc:2,sample_count:input.samples.length,
    sample_ids:input.samples.map(s=>s.id),document_ids:input.samples.map(s=>s.document_id),
    samples_sha256:sha256(JSON.stringify(input)),condition_id:conditionId,configuration,
    code_identity:code,environment_contract_sha256:admission.contract_sha256,
    forecast_cells:0,artifacts_directory:artifacts.directory};
  const registry=new ExperimentRegistry(SHARED_REGISTRY_PATH);
  const run=registry.prepareRun({experimentKey:conditionId,tag:'reader-cleaning-samples',expectedCells:0,cells:[],config});
  registry.markRunning(run.runId,dir);
  const rows:any[]=[]; let cursor=0,stop=false,fatal:string|undefined;
  const manifest={schema:'raven.reader-cleaning-eval.v1',run_id:run.runId,status:'running',owner:userInfo().username,
    host:hostname(),started_at_utc:new Date().toISOString(),config};
  const summary=()=>({completed:rows.length,expected:input.samples.length,cleaned:rows.filter(r=>r.status==='cleaned').length,
    unusable:rows.filter(r=>r.status==='unusable').length,failed:rows.filter(r=>r.status==='failed').length,
    reused:rows.filter(r=>r.cache_hit).length,excerpt_checks:rows.flatMap(r=>r.checks??[]).length,
    excerpt_checks_passed:rows.flatMap(r=>r.checks??[]).filter(c=>c.passed).length,usage:cleaner.snapshot()});
  const flush=()=>{save(join(dir,'sample-results.json'),rows);save(join(dir,'manifest.json'),{...manifest,summary:summary(),heartbeat_utc:new Date().toISOString()});};
  flush();
  const heartbeat=setInterval(()=>{registry.heartbeat(run.runId);flush();},15000);
  const onStop=()=>{stop=true;};process.on('SIGINT',onStop);process.on('SIGTERM',onStop);
  try {
    await notifyRegisteredStart(registry,run.runId);
    async function worker() {
      while (!stop && !fatal && cursor<input.samples.length) {
        const index=cursor++, s=input.samples[index]!,d=documents[index]!; const start=Date.now();
        try {
          const result=await cleaner.clean({url:d.url,title:d.title,body:d.body});
          const receipt=artifacts.get<any>(result.receiptId);
          const selected=receipt.blocks.filter((b:any)=>result.decisions.find(x=>x.id===b.id)?.action==='keep').map((b:any)=>d.body.slice(b.start,b.end)).join('');
          if (result.status!=='failed' && selected!==result.body) throw new Error('Output differs from selected original spans');
          const sampleDir=join(dir,s.id);mkdirSync(sampleDir,{mode:0o2750});
          writeFileSync(join(sampleDir,'before.md'),d.body,{mode:0o640});writeFileSync(join(sampleDir,'after.md'),result.body,{mode:0o640});
          save(join(sampleDir,'receipt.json'),receipt);
          const row={sample_id:s.id,document_id:s.document_id,provenance_id:d.provenanceId,url:d.url,
            status:result.status,cache_hit:result.cacheHit,input_sha256:d.bodySha256,output_sha256:sha256(result.body),
            before_chars:d.body.length,after_chars:result.body.length,blocks:receipt.blocks.length,
            dropped_blocks:result.decisions.filter(x=>x.action==='drop').length,
            receipt_id:result.receiptId,elapsed_ms:Date.now()-start,model_calls:result.modelCalls,cost_usd:result.costUsd,
            exact_original_spans:result.status!=='failed',checks:checkCleaningOutput(result.body,s.checks)};
          rows.push(row);console.log(JSON.stringify({...row,checks:row.checks.map(c=>({action:c.action,passed:c.passed}))}));flush();
        } catch(error) {fatal=error instanceof Error?error.message:String(error);rows.push({sample_id:s.id,status:'failed',error:fatal});flush();}
      }
    }
    await Promise.all([worker(),worker()]);
  } catch(error) {fatal=error instanceof Error?error.message:String(error);}
  finally {
    clearInterval(heartbeat);process.off('SIGINT',onStop);process.off('SIGTERM',onStop);
    const status=fatal || rows.some(r=>r.status==='failed') ? 'failed' : stop ? 'interrupted' : 'completed';
    manifest.status=status;flush();save(join(dir,'manifest.json'),{...manifest,summary:summary(),finished_at_utc:new Date().toISOString(),error:fatal??null});
    registry.finishRun(run.runId,status,fatal);
    try {console.log(await publishRegisteredRun(registry,run.runId));} finally {registry.close();}
    if (status!=='completed') process.exitCode=1;
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
