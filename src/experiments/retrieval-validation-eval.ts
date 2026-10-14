import {FrozenWorkerPool,withTiming,timed} from '../../vendor/retrieval-infra/src/index.js';
import {assertSearchProviderReady} from '../../vendor/retrieval-infra/src/retrieval/search-providers.js';
import {corpusRetrievalIdentity} from '../corpus/retrieval-identity.js';
/** Fixed-page acquisition and temporal-review diagnostics; never creates forecast cells. */
import {appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync, existsSync, chmodSync, readdirSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {serializeError} from '../tracing/trace-archive.js';
import {pathToFileURL} from 'node:url';
import {userInfo, hostname} from 'node:os';
import {EvidenceStore, PageDater, pageAcquisitionPolicy, DOCUMENT_POLICY, createRetrievalRuntime, createSearchProvider, webExecutionPolicy, WikipediaCache, WikiSnapshot, EVIDENCE_REVIEW_DEFAULT_CONCURRENCY, READER_CLEANING_DEFAULT_CONCURRENCY} from '../../vendor/retrieval-infra/src/index.js';
import type {EvidenceDocument} from '../../vendor/retrieval-infra/src/retrieval/document-reader.js';
import {sha256} from '../tracing/trace-archive.js';
import {createLlmClient} from '../llm/benchmark-providers.js';
import {OpenAiCompatibleClient} from '../../vendor/retrieval-infra/src/llm/openai-compatible.js';
import {FallbackLlmClient} from '../../vendor/retrieval-infra/src/llm/fallback-client.js';
import {ExperimentRegistry, experimentCodeIdentity} from './registry.js';
import {checkEnvironment} from './environment-check.js';
import {notifyRegisteredStart, publishRegisteredRun} from './registered-run-lifecycle.js';
import {configureSearchHttpConcurrency} from '../retrieval/search-providers.js';
import {PKG_ROOT} from '../paths.js';
import {SHARED_BENCH_DIR, SHARED_REGISTRY_PATH, SHARED_RESULTS_DIR, SHARED_RUNS_ROOT} from '../path-config.js';
import { projectEnv } from "../env-names.js";

type Sample={id:string;entity?:string;since?:string;until?:string;query?:string;n?:number;url?:string;document_id?:string;old_receipt_id?:string;anchor?:string;
  context?:{question?:string;resolutionCriteria?:string};checks?:{quote:string;reason:string}[]};
type Input={search_concurrency?:number;mode:'review'|'acquisition'|'search'|'frozen';evidence_directory?:string;samples:Sample[];
  concurrency?:number;candidate_concurrency?:number;review_concurrency?:number;cleaning_concurrency?:number;
  fetch_concurrency?:number;reader_concurrency?:number;reader_rpm?:number;page_dispatch_concurrency?:number;
  verify_cached_fetch?:boolean;search_delivery?:'fulltext'|'summary';replicate?:number;replicate_reason?:string;frozen_queue?:number;frozen_workers?:number;frozen_global_slots?:number;shared_frozen_cache?:string; shared_cache_directory?:string;fixed_document_manifest?:string;corpus_file?:string;wiki_cache?:string;wiki_manifest?:string;wiki_index?:string;source_manifest?:string;query_expansion?:boolean;content_processing?:'whole-document'|'integrated'|'single-pass';
  scheduling?:'rolling'|'batches';provider?:'serper'|'brave';browser?:boolean;review_model?:string;review_fallback_model?:string;review_thinking?:'disabled';review_max_output_tokens?:number};
function save(path:string,value:unknown) {const temp=`${path}.${process.pid}.tmp`;writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o640});renameSync(temp,path);}
function inventory(root:string):{path:string;sha256:string;bytes:number}[]{
  return readdirSync(root).sort().flatMap(name=>{const path=join(root,name);const stat=statSync(path);
    return stat.isDirectory()?inventory(path):[{path,sha256:sha256(readFileSync(path)),bytes:stat.size}];});
}
export function validateRetrievalSamples(value:unknown): asserts value is Input {
  const v=value as Input;
  if(!v || !['review','acquisition','search','frozen'].includes(v.mode) || !Array.isArray(v.samples) || !v.samples.length || v.samples.length>1024)throw new Error('Expected 1–1024 fixed samples and explicit mode');
  for(const field of ['concurrency','candidate_concurrency','review_concurrency','cleaning_concurrency','search_concurrency','fetch_concurrency','reader_concurrency','reader_rpm','page_dispatch_concurrency'] as const)
    if(v[field]!==undefined && (!Number.isSafeInteger(v[field])||v[field]!<1))throw new Error(field+' must be a positive safe integer');
  if(v.replicate!==undefined&&(!Number.isSafeInteger(v.replicate)||v.replicate<1||!v.replicate_reason?.trim()))throw new Error('Performance replicate needs a positive number and reason');
  if(v.replicate_reason&&!v.replicate)throw new Error('Replicate reason requires replicate');
  if(v.frozen_queue!==undefined&&(v.mode!=='frozen'||!Number.isSafeInteger(v.frozen_queue)||v.frozen_queue<1))throw new Error('frozen_queue must be a positive safe integer in frozen mode');
  if(v.shared_frozen_cache!==undefined&&(v.mode!=='frozen'||typeof v.shared_frozen_cache!=='string'||!v.shared_frozen_cache.trim()))throw new Error('shared_frozen_cache requires a nonempty path in frozen mode');
  if(v.frozen_global_slots!==undefined&&(v.mode!=='frozen'||!v.shared_frozen_cache||!Number.isSafeInteger(v.frozen_global_slots)||v.frozen_global_slots<1||v.frozen_global_slots>32))throw new Error('frozen_global_slots requires frozen cache and 1–32 slots');
  webExecutionPolicy({candidateConcurrency:v.candidate_concurrency,scheduling:v.scheduling});
  if(v.provider!==undefined&&!['serper','brave'].includes(v.provider))throw new Error('Invalid search provider');
  for(const field of ['review_model','review_fallback_model'] as const) if(v[field]!==undefined&&!/^[a-z0-9_-]+:.+/.test(v[field]!))throw new Error(field+' requires provider:model');
  if(v.review_thinking!==undefined&&(v.review_thinking!=='disabled'||v.mode!=='review'||(v.review_model??'deepseek:deepseek-flash')!=='deepseek:deepseek-flash'||v.review_fallback_model))throw new Error('Disabled thinking diagnostics require archived review mode with native DeepSeek Flash and no fallback');
  if(v.review_max_output_tokens!==undefined&&(v.review_thinking!=='disabled'||!Number.isSafeInteger(v.review_max_output_tokens)||v.review_max_output_tokens<1||v.review_max_output_tokens>384000))throw new Error('Review output limit requires disabled thinking and 1–384000 tokens');
  if(v.review_fallback_model&&v.review_fallback_model===v.review_model)throw new Error('review_fallback_model must differ from review_model');
  if(v.browser!==undefined&&typeof v.browser!=='boolean')throw new Error('Invalid browser switch');
  if(v.verify_cached_fetch!==undefined&&(typeof v.verify_cached_fetch!=='boolean'||v.mode!=='search'))throw new Error('Cached fetch verification requires search mode');
  if(v.search_delivery!==undefined&&(!['fulltext','summary'].includes(v.search_delivery)||!['review','search'].includes(v.mode)||(v.content_processing??'single-pass')!=='single-pass'))throw new Error('Invalid summary delivery mode');
  if(v.content_processing!==undefined&&!['whole-document','integrated','single-pass'].includes(v.content_processing))throw new Error('Invalid content processing');
  if(v.source_manifest&&(typeof v.source_manifest!=='string'||!['review','search'].includes(v.mode)||(v.content_processing??'single-pass')!=='single-pass'))throw new Error('Source manifest requires single-pass web processing');
  if(v.query_expansion!==undefined&&typeof v.query_expansion!=='boolean')throw new Error('Invalid expansion switch');
  if(v.mode==='frozen'&&!v.corpus_file)throw new Error('Frozen diagnostics require explicit corpus file');
  if((v.wiki_index&&!v.wiki_manifest)||(v.wiki_manifest&&!v.wiki_cache)||(v.mode!=='frozen'&&(v.wiki_manifest||v.corpus_file||v.query_expansion)))throw new Error('Invalid frozen options');
  if(v.frozen_workers!==undefined&&(!Number.isInteger(v.frozen_workers)||v.frozen_workers<1||v.frozen_workers>32))throw new Error('frozen_workers must be 1–32');
  const ids=new Set<string>();
  for(const s of v.samples){
    if(!s || !/^[a-z0-9_-]+$/.test(s.id) || ids.has(s.id))throw new Error('Invalid or duplicate sample ID');ids.add(s.id);
    if(v.mode==='review'){
      if(typeof v.evidence_directory!=='string' || !/^[a-f0-9]{64}$/.test(s.document_id??'') || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(s.anchor??'') || !Number.isFinite(Date.parse(s.anchor!)))throw new Error('Review needs archived document and exact anchor');
      if(s.context && Object.entries(s.context).some(([k,val])=>!['question','resolutionCriteria'].includes(k)||typeof val!=='string'))throw new Error('Unexpected review context field');
    }else if(v.mode==='search'||v.mode==='frozen'){
      if(s.entity!==undefined){
        if(v.mode!=='frozen'||!s.entity.trim()||s.entity.length>4000||s.query!==undefined)throw new Error('Entity browse requires frozen and exactly one entity');
        for(const date of [s.since,s.until])if(date!==undefined&&!Number.isFinite(Date.parse(date)))throw new Error('Invalid browse date');
        if(s.since&&s.until&&Date.parse(s.since)>=Date.parse(s.until))throw new Error('Empty browse date range');
      }else if(!s.query?.trim()||s.query.length>4000||s.since!==undefined||s.until!==undefined)throw new Error('Search needs query or explicit entity browse');
      if(!Number.isInteger(s.n??10)||(s.n??10)<1||(s.n??10)>20)throw new Error('Search needs 1–20 requested results');
      if(!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(s.anchor??'')||!Number.isFinite(Date.parse(s.anchor!)))throw new Error('Search needs exact anchor');
      if(s.context&&Object.entries(s.context).some(([k,val])=>!['question','resolutionCriteria'].includes(k)||typeof val!=='string'))throw new Error('Unexpected search context field');
    }else{
      const url=new URL(s.url??'');if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid acquisition URL');
    }
    if(s.checks && (!Array.isArray(s.checks)||s.checks.some(c=>!c.quote?.trim()||!c.reason?.trim())))throw new Error('Invalid content check');
  }
}

async function main(){
  if(process.argv.length!==3 || projectEnv("FABENCH_RETRIEVAL_DIAGNOSTIC_LOCK")!=='1'||projectEnv("FABENCH_SHARED_LIFECYCLE")!=='1')throw new Error('Use the shared retrieval-validation launcher');
  const dir=realpathSync(projectEnv("FABENCH_RESULTS_DIR")!);
  if(!dir.startsWith(SHARED_RESULTS_DIR+'/'))throw new Error('Shared results directory required');
  const parsed:unknown=JSON.parse(readFileSync(resolve(process.argv[2]!),'utf8'));validateRetrievalSamples(parsed);
  const input:Input=parsed;
  const usesWeb=input.mode==='search'||input.mode==='review';
  const usesModel=usesWeb||input.query_expansion===true;
  const searchHttpPolicy=usesWeb?configureSearchHttpConcurrency(input.search_concurrency):null;
  const model=input.review_model??'deepseek:deepseek-flash';
  const admission=checkEnvironment(PKG_ROOT,[],{diagnosticModel:model,diagnosticKind:'retrieval-validation',diagnosticUsesModel:usesModel});
  save(join(dir,'environment-check.json'),admission);
  if(!admission.ok)throw new Error('Environment admission failed: '+admission.checks.filter(c=>!c.ok).map(c=>c.name+': '+c.detail).join('; '));
  const acquisition={fetchConcurrency:input.fetch_concurrency,readerConcurrency:input.reader_concurrency,readerRpm:input.reader_rpm,dispatchConcurrency:input.page_dispatch_concurrency};
  let store:FrozenWorkerPool|undefined,wiki:WikiSnapshot|undefined,corpusIdentity:ReturnType<typeof corpusRetrievalIdentity>|undefined;
  const documents:EvidenceDocument[]=[];
  if(input.mode==='review'){
    const sourcePath=realpathSync(input.evidence_directory!);if(!sourcePath.startsWith(SHARED_RUNS_ROOT+'/'))throw new Error('Use shared archived inputs');
    const source=new EvidenceStore(sourcePath);
    for(const s of input.samples){const d=source.get<Omit<EvidenceDocument,'id'>>(s.document_id!);
      if(typeof d.body!=='string'||sha256(d.body)!==d.bodySha256||!d.title||!d.url||!['live-page','wikipedia-revision'].includes(d.temporalBasis))throw new Error('Invalid candidate '+s.id);
      documents.push({...d,id:s.document_id!});}
  }
  if(input.mode==='frozen'){
    corpusIdentity=corpusRetrievalIdentity(realpathSync(input.corpus_file!));
    if(corpusIdentity.kind!=='historical-fts-index'||input.samples.some(s=>new Date(s.anchor!).toISOString()!==corpusIdentity!.anchor))throw new Error('Frozen samples must match completed index anchor');
    store=new FrozenWorkerPool({corpusPath:input.corpus_file!,workers:input.frozen_workers,maxQueue:input.frozen_queue,sharedCachePath:input.shared_frozen_cache,sharedCacheSlots:input.frozen_global_slots,wikiCachePath:input.wiki_cache,wikiManifestFile:input.wiki_manifest,wikiIndexFile:input.wiki_index});
    if(input.wiki_manifest){const cache=new WikipediaCache(input.wiki_cache!,true);try{wiki=new WikiSnapshot(cache,JSON.parse(readFileSync(input.wiki_manifest,'utf8')),input.wiki_index);for(const sample of input.samples)wiki.assertAnchor(sample.anchor!);}finally{cache.close();}}
  }
  save(join(dir,'samples.json'),input);
  const code=experimentCodeIdentity(PKG_ROOT);
  const cacheRoot=join(SHARED_BENCH_DIR,'retrieval-validation-cache',code.source_fingerprint_sha256,input.mode);
  mkdirSync(cacheRoot,{recursive:true,mode:0o2770});
  // Equal input pages alone do not control a sweep if later arms inherit cleaned
  // evidence pages. Keep persistent page/cleaner caches separate by treatment;
  // retries of the same treatment still reuse completed samples and artifacts.
  const cacheTreatment={replicate:input.replicate??0,replicate_reason:input.replicate_reason??null,frozen_workers:input.frozen_workers??null,frozen_queue:input.frozen_queue??null,shared_frozen_cache:input.shared_frozen_cache??null,frozen_global_slots:input.frozen_global_slots??4,policy:'isolated-treatment-cache-v1',mode:input.mode,
    acquisition:pageAcquisitionPolicy(acquisition),
    searchHttpPolicy,
    concurrency:input.concurrency??(input.mode==='review'?4:1),
    candidateConcurrency:webExecutionPolicy({candidateConcurrency:input.candidate_concurrency}).candidate_concurrency,reviewConcurrency:input.review_concurrency??EVIDENCE_REVIEW_DEFAULT_CONCURRENCY,
    cleaningConcurrency:input.cleaning_concurrency??READER_CLEANING_DEFAULT_CONCURRENCY,scheduling:input.scheduling??'rolling',
    ...(input.review_thinking?{reviewThinking:input.review_thinking,reviewMaxOutputTokens:input.review_max_output_tokens??null}:{}),
    provider:input.provider??'serper',browser:input.browser??false,
    verifyCachedFetch:input.verify_cached_fetch??false,searchDelivery:input.search_delivery??'fulltext',contentProcessing:input.content_processing??'single-pass',sourceManifest:input.source_manifest?sha256(readFileSync(input.source_manifest)):null,queryExpansion:input.query_expansion??false};
  const artifacts=new EvidenceStore(join(cacheRoot,'treatments',sha256(JSON.stringify(cacheTreatment)),'evidence'));
  const modelClient=(spec:string)=>{const i=spec.indexOf(':');return createLlmClient(spec.slice(0,i),spec.slice(i+1));};
  const baseClient=usesModel?modelClient(model):undefined;
  if(input.review_thinking && !(baseClient instanceof OpenAiCompatibleClient))throw new Error('Explicit review thinking requires the native compatible client');
  const primaryClient=input.review_thinking?(baseClient as OpenAiCompatibleClient).withThinkingDisabled(input.review_max_output_tokens):baseClient;
  const client=primaryClient&&input.review_fallback_model?new FallbackLlmClient(primaryClient,modelClient(input.review_fallback_model)):primaryClient;
  const concurrency=input.concurrency??(input.mode==='review'?4:1);
  const runtime=input.mode!=='acquisition'?createRetrievalRuntime({acquisition,sharedCacheDirectory:input.shared_cache_directory,fixedDocumentManifestFile:input.fixed_document_manifest,store,wikiSnapshot:wiki,wikiCachePath:input.wiki_cache,queryExpansionClient:input.query_expansion?client:undefined,artifacts,provider:usesWeb?createSearchProvider(input.provider??'serper'):undefined,reviewerClient:usesWeb?client:undefined,browser:input.browser??false,
    webExecution:{candidateConcurrency:input.candidate_concurrency,scheduling:input.scheduling},
    reviewOptions:{concurrency:input.review_concurrency,processing:input.content_processing,searchDelivery:input.search_delivery,sourceManifestFile:input.source_manifest},cleaningOptions:{concurrency:input.cleaning_concurrency}}):undefined;
  const daters=input.mode==='acquisition'?[false,true].map(browser=>new PageDater(true,undefined,undefined,undefined,
    {policy:DOCUMENT_POLICY,rawDirectory:join(artifacts.directory,browser?'browser-raw':'baseline-raw'),browser},acquisition)):[];
  for(const d of documents){const {id,...raw}=d;if(artifacts.put(raw)!==id)throw new Error('Candidate identity changed');}
  for(const p of [cacheRoot,artifacts.directory,join(cacheRoot,'completed')]){mkdirSync(p,{recursive:true,mode:0o2770});chmodSync(p,0o2770);}
  const configuration={mode:input.mode,concurrency,cache_treatment:cacheTreatment,corpus:corpusIdentity??null,frozen_execution:store?.execution??null,fixed_documents:runtime?.fixedDocuments??null,wiki:wiki?.identity??null,expansion:runtime?.expander?.configuration()??null,execution:webExecutionPolicy({candidateConcurrency:input.candidate_concurrency,scheduling:input.scheduling}),review:runtime?.reviewer?.configuration(),acquisition:runtime?.dater.configuration()??daters.map(d=>d.configuration()),cleaning:runtime?.cleaner?.configuration()??null};
  const conditionId='retrieval-validation:'+sha256(JSON.stringify(configuration));
  const config={execution_mode:'retrieval-validation',diagnostic_mode:input.mode,model:usesModel?model:'no LLM',
    llm:usesModel?model:null,review_fallback_model:input.review_fallback_model??null,review_client:usesWeb?client?.id:null,conc:concurrency,sample_count:input.samples.length,sample_ids:input.samples.map(s=>s.id),
    samples_sha256:sha256(JSON.stringify(input)),condition_id:conditionId,configuration,code_identity:code,
    environment_contract_sha256:admission.contract_sha256,environment_admission:admission,forecast_cells:0,artifacts_directory:artifacts.directory};
  const registry=new ExperimentRegistry(SHARED_REGISTRY_PATH);
  const run=registry.prepareRun({experimentKey:conditionId,tag:'retrieval-'+input.mode,expectedCells:0,cells:[],config});registry.markRunning(run.runId,dir);
  process.env.FABENCH_ACTIVE_RUN_ID=run.runId;
  const rows:any[]=[];let cursor=0,stop=false,fatal:string|undefined;
  const loop=monitorEventLoopDelay({resolution:20});loop.enable();
  const processStarted=performance.now(),cpuStarted=process.cpuUsage();
  const eventsFile=join(dir,'events.jsonl');
  const event=(kind:string,data:unknown)=>appendFileSync(eventsFile,JSON.stringify({kind,at_utc:new Date().toISOString(),monotonic_ms:performance.timeOrigin+performance.now(),data})+'\n',{mode:0o640});
  event('run_started',{run_id:run.runId,config});
  const manifest={schema:'raven.retrieval-validation.v1',run_id:run.runId,status:'running',owner:userInfo().username,host:hostname(),started_at_utc:new Date().toISOString(),config};
  const summary=()=>({completed:rows.length,expected:input.samples.length,reused:rows.filter(r=>r.reused).length,
    dispositions:Object.fromEntries([...new Set(rows.map(r=>r.status))].map(k=>[k,rows.filter(r=>r.status===k).length])),
    frozen_pool:store?.stats()??null,search_provider:runtime?.provider?.stats()??null,process:{wall_ms:performance.now()-processStarted,cpu:process.cpuUsage(cpuStarted),memory:process.memoryUsage(),resource:process.resourceUsage(),event_loop_p99_ms:loop.percentile(99)/1e6},review_usage:runtime?.reviewer?.snapshot(),query_expansion_usage:runtime?.expander?.snapshot(),cleaning_usage:runtime?.cleaner?.snapshot(),page_stats:runtime?.dater.snapshot()??daters.map(d=>d.snapshot()),reader_failures:runtime?.reader.failures??[],
    search_reader_cost:'Search and Reader fees not returned by these interfaces; model usage reported separately'});
  const flush=()=>{
    save(join(dir,'sample-results.json'),rows);
    save(join(dir,'manifest.json'),{...manifest,summary:summary(),heartbeat_utc:new Date().toISOString()});
    const resourceMetricsFile=projectEnv("FABENCH_RESOURCE_METRICS_FILE");
    if(resourceMetricsFile){
      const failed=rows.filter(r=>['infrastructure_failed','review_failed'].includes(r.status));
      save(resourceMetricsFile,{
        unit:'retrieval_sample',
        completed_units:rows.filter(r=>!r.reused&&!failed.includes(r)).length,
        failed_units:failed.length,
        reused_units:rows.filter(r=>r.reused).length,
        latencies_ms:rows.filter(r=>!r.reused&&!failed.includes(r)).map(r=>r.elapsed_ms),
      });
    }
  };flush();
  const heartbeat=setInterval(()=>{registry.heartbeat(run.runId);flush();},15_000);
  const onStop=()=>{stop=true;event('signal_received',{signal:'SIGINT_or_SIGTERM'});};process.on('SIGINT',onStop);process.on('SIGTERM',onStop);
  try{
    await notifyRegisteredStart(registry,run.runId);
    if(runtime?.provider&&(input.mode==='search'||input.mode==='review'))
      await assertSearchProviderReady(runtime.provider,receipt=>save(join(dir,'search-preflight.json'),receipt));
    // Only after registration/notice: browser proof plus authenticated Reader preflight.
    if(runtime&&usesWeb)await runtime.dater.assertReady();else for(const d of daters)await d.assertReady();
    async function worker(){while(!stop&&!fatal&&cursor<input.samples.length){
      const index=cursor++,s=input.samples[index]!,started=Date.now();
      event('sample_started',{sample_id:s.id,kind:s.entity?'browse':input.mode});
      const key=sha256(JSON.stringify({conditionId,document_id:s.document_id,url:s.url,query:s.query,entity:s.entity,since:s.since,until:s.until,n:s.n,anchor:s.anchor,context:s.context??{}})),cache=join(cacheRoot,'completed',key+'.json');
      try{
        let row:any;
        if(existsSync(cache)){const prior=JSON.parse(readFileSync(cache,'utf8'));row={...prior,sample_id:s.id,reused:true,original_cost_usd:prior.costUsd,costUsd:0,modelCalls:0,searchCalls:0,readCalls:0,elapsed_ms:Date.now()-started};}
        else if(store&&s.entity){
          const result=await withTiming({questionId:s.id},e=>{event('stage_timing',e);artifacts.put({operation:'stage-timing',event:e});},()=>store!.browse({entity:s.entity!,since:s.since,until:s.until,limit:s.n??10},s.anchor!));
          const sampleDir=join(dir,s.id);mkdirSync(sampleDir,{recursive:true,mode:0o2770});save(join(sampleDir,'search.json'),result);
          row={sample_id:s.id,entity:s.entity,kind:'browse',status:'searched',served:result.results.length,output_sha256:sha256(JSON.stringify(result.results)),elapsed_ms:Date.now()-started,reused:false};save(cache,row);
        }else if(runtime && (input.mode==='search'||input.mode==='frozen')){
          const backend=runtime.createBackend(input.mode==='frozen'?'frozen':'web-filter');
          const result=await withTiming({questionId:s.id},e=>{event('stage_timing',e);artifacts.put({operation:'stage-timing',event:e});},()=>timed('search',()=>backend.searchWithTrace(s.query!,s.n??10,s.anchor!,s.context??{})));
          const sampleDir=join(dir,s.id);mkdirSync(sampleDir,{recursive:true,mode:0o2770});
          save(join(sampleDir,'search.json'),result);
          let cachedFetch:unknown;
          if(input.verify_cached_fetch){
            const before={review:runtime.reviewer!.snapshot(),acquisition:runtime.dater.snapshot()};
            const fetched=[];
            for(const hit of result.results){
              const began=performance.now(),read=await backend.fetchWithTrace(hit.url,s.anchor!,s.context??{});
              if(!read.doc||read.doc.documentId!==hit.documentId||read.doc.body.length!==hit.fullBodyChars)throw new Error('Cached fulltext identity or length changed');
              const stored=artifacts.get<Omit<EvidenceDocument,'id'>>(hit.documentId!);
              if(sha256(read.doc.body)!==stored.bodySha256)throw new Error('Cached fulltext bytes changed');
              writeFileSync(join(sampleDir,hit.documentId+'.md'),read.doc.body,{mode:0o640});
              fetched.push({document_id:hit.documentId,summary_chars:hit.snippet.length,fulltext_chars:read.doc.body.length,sha256:stored.bodySha256,elapsed_ms:performance.now()-began});
            }
            const after={review:runtime.reviewer!.snapshot(),acquisition:runtime.dater.snapshot()};
            if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Cached fetch performed additional acquisition or review work');
            cachedFetch={before,after,fetched};save(join(sampleDir,'cached-fetch.json'),cachedFetch);
          }
          row={sample_id:s.id,query:s.query,anchor:s.anchor,status:'searched',served:result.results.length,
            cached_fetch:cachedFetch,funnel:result.funnel,audit:result.audit,output_sha256:sha256(JSON.stringify(result.results)),
            elapsed_ms:Date.now()-started,reused:false};save(cache,row);
        }else if(runtime){
          const result=await runtime.reviewer!.review(documents[index]!,s.anchor!,s.context??{});
          const receipt=artifacts.get<any>(result.receiptId);
          row={sample_id:s.id,document_id:s.document_id,old_receipt_id:s.old_receipt_id??null,url:documents[index]!.url,
            input_sha256:documents[index]!.bodySha256,anchor:s.anchor,
            ...result,review_status:result.status,disposition:result.failure?'review_failed':result.status,
            validation_feedback:receipt.trace.filter((t:any)=>t.validation),elapsed_ms:Date.now()-started,reused:result.cacheHit};
          row.status=row.disposition;
          const sampleDir=join(dir,s.id);mkdirSync(sampleDir,{mode:0o2770});save(join(sampleDir,'receipt.json'),receipt);
          writeFileSync(join(sampleDir,'candidate.md'),documents[index]!.body,{mode:0o640});
          if(result.status==='supported'){const approved=result.admittedDocumentId?artifacts.get<Omit<EvidenceDocument,'id'>>(result.admittedDocumentId):documents[index]!;writeFileSync(join(sampleDir,'admitted.md'),approved.body,{mode:0o640});row.search_summary=approved.searchSummary??null;row.summary_policy=approved.summaryPolicy??null;row.admitted_sha256=approved.bodySha256;row.admitted_chars=approved.body.length;}
          if(!result.failure)save(cache,row);
        }else{
          const variants:any[]=[];const order=parseInt(sha256(s.url!).slice(0,2),16)%2?[1,0]:[0,1];
          for(const arm of order){const page=(await daters[arm]!.fetchMany([s.url!]))[0];if(!page)throw new Error('Missing page response');
            if(page.quality_error)throw new Error(page.quality_error);
            const id=artifacts.put(page),sampleDir=join(dir,s.id);mkdirSync(sampleDir,{recursive:true,mode:0o2770});
            writeFileSync(join(sampleDir,arm?'browser.md':'baseline.md'),page.text,{mode:0o640});
            variants.push({arm:arm?'with-browser':'http-reader',page_id:id,source:page.source,chars:page.text.length,body_sha256:sha256(page.text),
              usable:!!page.content_document?.usable,complete:!!page.content_document?.complete,why:page.why,ms:page.ms,
              table_blocks:(page.content_document?.table_blocks as any[])?.length??0,browser_attempts:page.attempts??[],
              checks:(s.checks??[]).map(c=>({...c,passed:page.text.includes(c.quote)}))});}
          row={sample_id:s.id,url:s.url,status:'captured',variants,elapsed_ms:Date.now()-started,reused:false};save(cache,row);
        }
        rows.push(row);event('sample_finished',row);flush();console.log(JSON.stringify({sample_id:s.id,status:row.status,elapsed_ms:row.elapsed_ms,cost_usd:row.costUsd,reused:row.reused}));
      }catch(error){fatal=error instanceof Error?error.message:String(error);const failure={sample_id:s.id,status:'infrastructure_failed',error:serializeError(error),elapsed_ms:Date.now()-started};rows.push(failure);event('sample_failed',failure);flush();}
    }}
    await Promise.all(Array.from({length:Math.min(concurrency,input.samples.length)},()=>worker()));
  }catch(error){fatal=error instanceof Error?error.message:String(error);event('run_failed',serializeError(error));}
  finally{
    clearInterval(heartbeat);loop.disable();event('run_stopping',{fatal,stop,unstarted:input.samples.slice(cursor).map(s=>s.id)});process.off('SIGINT',onStop);process.off('SIGTERM',onStop);runtime?.close();wiki?.close();store?.close();daters.forEach(d=>d.close());
    const status=fatal?'failed':stop?'interrupted':'completed';manifest.status=status;flush();
    save(join(dir,'manifest.json'),{...manifest,summary:summary(),finished_at_utc:new Date().toISOString(),error:fatal??null});
    save(join(dir,'artifact-inventory.json'),{scope:'All archived inputs, requests, replies, source pages and receipts in this code/mode cache',files:inventory(artifacts.directory)});
    registry.finishRun(run.runId,status,fatal);
    try{console.log(await publishRegisteredRun(registry,run.runId));}finally{registry.close();}
    if(status!=='completed')process.exitCode=1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(JSON.stringify(serializeError(e)));process.exitCode=1;});
