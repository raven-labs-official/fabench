import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FROZEN_SHARED_CACHE } from "../path-config.js";
import { PKG_ROOT } from "../paths.js";
import { formalArguments, validateFormalFiles, dependencyDigest, checkEnvironment, checkoutAdvisory, loadAdmissionReceipt } from "./environment-check.js";
import { readForecastOptions } from "./forecast/options.js";
import { loadForecastQuestions } from "./forecast/questions.js";
import { formalQuestionIds, needsFormalSet, SYNTHETIC_GRADING, SYNTHETIC_QUESTIONS } from "../datasets/test-fixtures.js";
import { clearProjectEnv, projectEnv } from "../env-names.js";

const basic=["--llm","bailian:qwen3.8-flash","--settings","none","--conc","5"];
test("the experimenter may select a different checkout; current differences are advisory",()=>{
  assert.equal(checkoutAdvisory("selected", "selected"),null);
  assert.equal(checkoutAdvisory("selected", null),null);
  assert.match(checkoutAdvisory("selected", "current")!,/belongs to the experimenter/);
});
test('frozen lead preview is explicit in admission, with legacy fulltext and incompatible modes checked',{skip:needsFormalSet},()=>{
  const frozen=basic.map(v=>v==='none'?'frozen':v);
  // The shared frozen-query cache is the default wherever it exists (the shared server), on both paths.
  assert.equal(formalArguments(frozen,PKG_ROOT,{sharedFrozenCacheAvailable:true}).selected['shared-frozen-cache'],FROZEN_SHARED_CACHE);
  assert.equal(formalArguments(frozen,PKG_ROOT,{sharedFrozenCacheAvailable:false}).selected['shared-frozen-cache'],undefined);
  assert.equal(formalArguments(basic,PKG_ROOT,{sharedFrozenCacheAvailable:true}).selected['shared-frozen-cache'],undefined);
  assert.throws(()=>formalArguments([...basic,'--shared-frozen-cache','/tmp/cache.db'],PKG_ROOT),/requires quality-v1 frozen/);
  assert.equal(formalArguments(frozen,PKG_ROOT).selected['frozen-search-delivery'],'lead');
  assert.equal(formalArguments([...frozen,'--frozen-search-delivery','fulltext'],PKG_ROOT).selected['frozen-search-delivery'],'fulltext');
  assert.equal(formalArguments([...frozen,'--tool-delivery','inline'],PKG_ROOT).selected['frozen-search-delivery'],'fulltext');
  assert.throws(()=>formalArguments([...frozen,'--frozen-search-delivery','summary'],PKG_ROOT),/lead or fulltext/);
  assert.throws(()=>formalArguments([...frozen,'--frozen-search-delivery','lead','--tool-delivery','inline'],PKG_ROOT),/requires quality-v1/);
});
test('shared admission records paged delivery and rejects a conflicting text prefix cap',{skip:needsFormalSet},()=>{
  const frozen=basic.map(v=>v==='none'?'frozen':v);
  assert.equal(formalArguments(frozen,PKG_ROOT).selected['tool-delivery'],'paged');
  assert.equal(formalArguments([...frozen,'--tool-delivery','inline'],PKG_ROOT).selected['tool-delivery'],'inline');
  assert.throws(()=>formalArguments([...frozen,'--tool-delivery','summary'],PKG_ROOT),/inline or paged/);
  const custom=[...frozen,'--profile','custom','--questions-file','/tmp/questions','--grading-file','/tmp/answers','--fetch-chars','4000','--retrieval-profile','baseline'];
  assert.throws(()=>formalArguments(custom,PKG_ROOT),/requires --fetch-chars 0/);
  assert.equal(formalArguments([...custom,'--tool-delivery','inline'],PKG_ROOT).selected['tool-delivery'],'inline');
});
test('shadow review requires a distinct explicit primary effort and retains both in admission',{skip:needsFormalSet},()=>{
  const web=[...basic.map(v=>v==='none'?'web-filter':v),'--leak-llm','deepseek:deepseek-flash'];
  const pair=[...web,'--review-effort','high','--shadow-review-effort','low'];
  const config=formalArguments(pair,PKG_ROOT);
  assert.equal(config.selected['review-effort'],'high');assert.equal(config.selected['shadow-review-effort'],'low');
  assert.throws(()=>formalArguments([...web,'--shadow-review-effort','low'],PKG_ROOT),/distinct explicit/);
  assert.throws(()=>formalArguments([...web,'--shadow-review-effort','high'],PKG_ROOT),/distinct explicit/);
  assert.throws(()=>formalArguments([...web,'--review-effort','low','--shadow-review-effort','low'],PKG_ROOT),/distinct explicit/);
  assert.throws(()=>formalArguments([...pair,'--content-processing','integrated'],PKG_ROOT),/single-pass/);
  assert.throws(()=>formalArguments([...pair,'--review-thinking','disabled'],PKG_ROOT),/conflicts/);
});
test('review effort is admitted independently from predictor effort and rejects incompatible review modes',{skip:needsFormalSet},()=>{
  const web=[...basic.map(v=>v==='none'?'web-filter':v),'--leak-llm','deepseek:deepseek-flash'];
  for(const effort of ['low','high','max']) {
    const result=formalArguments([...web,'--review-effort',effort],PKG_ROOT);
    assert.equal(result.selected['review-effort'],effort);
    assert.equal(result.selected.effort,undefined);
  }
  assert.equal(formalArguments(web,PKG_ROOT).selected['review-effort'],'low');
  for(const effort of ['none','medium',''])assert.throws(()=>formalArguments([...web,'--review-effort',effort],PKG_ROOT),/low, high or max/);
  assert.throws(()=>formalArguments([...basic,'--review-effort','low'],PKG_ROOT),/requires quality-v1 web-filter/);
  assert.throws(()=>formalArguments([...web,'--review-thinking','disabled','--review-effort','low'],PKG_ROOT),/conflicts/);
  assert.throws(()=>formalArguments([...web,'--leak-fallback-llm','glm:glm-5.3','--review-effort','low'],PKG_ROOT),/without a fallback/);
  assert.throws(()=>formalArguments([...web.map(v=>v==='deepseek:deepseek-flash'?'glm:glm-5.3':v),'--review-effort','low'],PKG_ROOT),/deepseek:deepseek-flash/);
  const result=formalArguments([...web,'--review-thinking','enabled','--review-effort','low','--effort','high'],PKG_ROOT);
  assert.equal(result.selected.effort,'high');assert.equal(result.selected['review-effort'],'low');
});
test('shared admission records low reviewer default while preserving explicit modes and predictor settings',{skip:needsFormalSet},()=>{
  const web=[...basic.map(v=>v==='none'?'web-filter':v),'--leak-llm','deepseek:deepseek-flash'];
  const result=formalArguments(web,PKG_ROOT);
  assert.equal(result.args[result.args.indexOf('--review-effort')+1],'low');
  assert.equal(result.selected.effort,undefined);
  assert.equal(result.selected['review-thinking'],undefined);
  for(const arm of ['none','frozen'])
    assert.equal(formalArguments(basic.map(v=>v==='none'?arm:v),PKG_ROOT).selected['review-effort'],undefined);
  for(const tail of [['--review-thinking','disabled'],['--leak-fallback-llm','glm:glm-5.3'],['--retrieval-profile','baseline']])
    assert.equal(formalArguments([...web,...tail],PKG_ROOT).selected['review-effort'],undefined);
  assert.equal(formalArguments(web.map(v=>v==='deepseek:deepseek-flash'?'glm:glm-5.3':v),PKG_ROOT).selected['review-effort'],undefined);
  const custom=[...basic.map(v=>v==='none'?'web-filter':v),'--profile','custom','--questions-file','/tmp/questions.jsonl','--grading-file','/tmp/answers.jsonl'];
  assert.equal(formalArguments(custom,PKG_ROOT).selected['review-effort'],'low');
  assert.throws(()=>formalArguments([...custom,'--leak-filter','0'],PKG_ROOT),/quality-v1 requires the evidence reviewer/);
  assert.equal(formalArguments(web.map(v=>v==='5'?'254':v),PKG_ROOT).selected.conc,'254');
});
test('review thinking is an explicit admitted web-filter setting and rejects incompatible conditions',{skip:needsFormalSet},()=>{
  const web=[...basic.map(v=>v==='none'?'web-filter':v),'--leak-llm','deepseek:deepseek-flash'];
  for(const mode of ['enabled','disabled']) {
    const result=formalArguments([...web,'--review-thinking',mode],PKG_ROOT);
    assert.equal(result.selected['review-thinking'],mode);
    assert.ok(result.args.includes(mode));
  }
  assert.equal(formalArguments(web,PKG_ROOT).selected['review-thinking'],undefined);
  for(const mode of ['off','false',''])assert.throws(()=>formalArguments([...web,'--review-thinking',mode],PKG_ROOT),/enabled or disabled/);
  assert.throws(()=>formalArguments([...basic,'--review-thinking','disabled'],PKG_ROOT),/requires quality-v1 web-filter/);
  assert.throws(()=>formalArguments([...web,'--retrieval-profile','baseline','--review-thinking','disabled'],PKG_ROOT),/requires quality-v1/);
  assert.throws(()=>formalArguments([...web,'--leak-fallback-llm','glm:glm-5.3','--review-thinking','disabled'],PKG_ROOT),/without a fallback/);
  assert.throws(()=>formalArguments([...web.map(v=>v==='deepseek:deepseek-flash'?'glm:glm-5.3':v),'--review-thinking','enabled'],PKG_ROOT),/deepseek:deepseek-flash/);
  const custom=['--profile','custom','--questions-file','/tmp/questions.jsonl','--grading-file','/tmp/answers.jsonl'];
  assert.equal(formalArguments([...web,...custom,'--review-thinking','disabled'],PKG_ROOT).selected['review-thinking'],'disabled');
  assert.throws(()=>formalArguments([...web,...custom,'--leak-filter','0','--review-thinking','disabled'],PKG_ROOT),/review enabled/);
});
test('replicate identifiers cannot silently disable an intended repeated experiment',{skip:needsFormalSet},()=>{
  for(const value of ['411','413','2','yes','01','TRUE'])
    assert.throws(()=>formalArguments([...basic,'--replicate',value,'--replicate-reason','capacity comparison'],PKG_ROOT),/replicate must be 0 or 1/);
  // Booleans read the same everywhere: 1/true and 0/false, recorded as 1 and 0.
  assert.equal(formalArguments([...basic,'--replicate','true','--replicate-reason','capacity comparison'],PKG_ROOT).selected.replicate,'1');
  assert.throws(()=>formalArguments([...basic,'--replicate','1'],PKG_ROOT),/nonempty/);
  assert.throws(()=>formalArguments([...basic,'--replicate-reason','capacity comparison'],PKG_ROOT),/requires --replicate 1/);
  assert.throws(()=>formalArguments([...basic,'--replicate','0','--replicate-reason','capacity comparison'],PKG_ROOT),/requires --replicate 1/);
  const repeated=formalArguments([...basic,'--replicate','1','--replicate-reason','capacity comparison'],PKG_ROOT);
  assert.equal(repeated.selected.replicate,'1');
  assert.equal(repeated.selected['replicate-reason'],'capacity comparison');
  assert.equal(formalArguments([...basic,'--replicate','0'],PKG_ROOT).selected.replicate,'0');
});
test("default admission pins formal 232 files and shared protocol without editing prompts",{skip:needsFormalSet},()=>{
  const before=readFileSync(join(PKG_ROOT,"question-making/curated/raven_model_test.jsonl"));
  assert.equal(validateFormalFiles(PKG_ROOT).count,232);
  const config=formalArguments(basic,PKG_ROOT);
  assert.equal(config.profile,"formal-232");assert.equal(config.selected.n,"232");
  assert.equal(config.selected["max-tool-calls"],"100");
  assert.throws(()=>formalArguments([...basic,"--max-tool-calls","20"],PKG_ROOT),/max-tool-calls 100/);
  assert.equal(config.selected["retrieval-profile"],"quality-v1");assert.equal(config.selected["date-gate"],undefined);assert.equal(config.selected["fetch-chars"],"0");
  assert.equal(config.selected["questions-file"],join(PKG_ROOT,"question-making/curated/raven_model_test.jsonl"));
  assert.deepEqual(before,readFileSync(config.selected["questions-file"]!));
});
test("ambiguous flags, old bank, missing explicit conditions and drifted formal settings are blocked",{skip:needsFormalSet},()=>{
  for(const tail of [["--n","20"],["--ledger","1"],["--fetch-chars","4000"],["--date-gate","content"],
    ["--registry","0"],["--conc","8"],["--unknown","1"],["--ids","not-a-question"],["--frozen-archive-file","captures.jsonl"]])
    assert.throws(()=>formalArguments([...basic,...tail],PKG_ROOT));
  assert.throws(()=>formalArguments(["--settings","none","--conc","5"],PKG_ROOT));
  assert.throws(()=>formalArguments(basic.map(v=>v==="none"?"web-filter":v),PKG_ROOT),/leak-llm/);
  assert.throws(()=>formalArguments([...basic,"--profile","custom"],PKG_ROOT),/explicit question/);
  const subset=formalQuestionIds().slice(0,2).join(",");
  assert.equal(formalArguments([...basic,"--ids",subset],PKG_ROOT).selected.n,"232","explicit retries still use the complete bank");
});
test("changed question bytes are recorded without a historical version lock",{skip:needsFormalSet},()=>{
  const dir=mkdtempSync(join(tmpdir(),"fabench-environment-"));
  try {
    cpSync(join(PKG_ROOT,"question-making/curated"),join(dir,"question-making/curated"),{recursive:true});
    const file=join(dir,"question-making/curated/raven_model_test.jsonl");
    const rows = readFileSync(file,"utf8").trim().split("\n").map(line => JSON.parse(line));
    rows[0].question_en += " (clarified wording)";
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    assert.notEqual(validateFormalFiles(dir).questions_sha256, validateFormalFiles(PKG_ROOT).questions_sha256);
    rows[0].cut_off_time = "not-a-date";
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    assert.throws(() => validateFormalFiles(dir), /Information cutoff/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test("dependency hashes remain available for publication; startup has no release/dependency version gates",{skip:needsFormalSet},()=>{
  const dir=mkdtempSync(join(tmpdir(),"fabench-dependencies-"));
  try {
    mkdirSync(join(dir,"node_modules"));const file=join(dir,"node_modules","runtime.js");
    writeFileSync(file,"one");const original=dependencyDigest(dir);writeFileSync(file,"two");
    assert.notEqual(dependencyDigest(dir),original);
    const report=checkEnvironment(PKG_ROOT,basic,{current:dir});
    assert.equal(report.checks.some(c => ["latest_published_release", "published_attestation", "runtime_and_dependencies"].includes(c.name)), false);
    assert.ok(report.warnings.some(w => w.includes("belongs to the experimenter")));
    assert.equal(report.checks.find(c => c.name === "question_inputs")?.ok, true);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("official launcher admits the current retrieval implementation with either provider",{skip:needsFormalSet},()=>{
  const web=basic.map(v=>v==="none"?"web-filter":v);
  assert.equal(formalArguments([...web,'--leak-llm','deepseek:deepseek-flash','--browser-fallback','1'],PKG_ROOT).selected['browser-fallback'],'1');
  assert.throws(()=>formalArguments([...web,'--leak-llm','deepseek:deepseek-flash','--browser-fallback','yes'],PKG_ROOT),/browser-fallback/);
  assert.throws(()=>formalArguments([...web,'--leak-llm','deepseek:deepseek-flash','--retrieval-profile','baseline','--browser-fallback','1'],PKG_ROOT),/requires quality/);
  for(const provider of ["serper","brave"]) {
    const config=formalArguments([...web,"--leak-llm","deepseek:deepseek-flash","--search-provider",provider,
      "--retrieval-evidence-dir","/tmp/fabench-unified-artifacts"],PKG_ROOT);
    assert.equal(config.selected["search-provider"],provider);
    assert.equal(config.selected["retrieval-profile"],"quality-v1");
    assert.equal(config.selected["date-gate"],undefined);
  }
  const legacy=formalArguments([...basic,"--retrieval-profile","baseline"],PKG_ROOT);
  assert.equal(legacy.selected["date-gate"],"strict");
  assert.throws(()=>formalArguments([...web,"--leak-llm","deepseek:deepseek-flash","--date-gate","strict"],PKG_ROOT),/baseline/);
  const frozen=formalArguments([...basic.map(v=>v==="none"?"frozen":v),"--frozen-corpus-file","/tmp/historical.db"],PKG_ROOT);
  assert.equal(frozen.selected["frozen-corpus-file"],"/tmp/historical.db");
});

test("shared admission forwards frozen workers and versioned review cache options to the runtime",{skip:needsFormalSet},()=>{
  const webArgs=[...basic.map(v=>v==='none'?'web-filter':v),'--leak-llm','glm:glm-5.3-flash','--leak-fallback-llm','deepseek:deepseek-flash','--search-delivery','summary'];
  const webAdmitted=formalArguments(webArgs,PKG_ROOT);
  assert.equal(webAdmitted.selected['search-delivery'],'summary');
  assert.equal(webAdmitted.selected['leak-fallback-llm'],'deepseek:deepseek-flash');
  const extra = ["--frozen-workers","2","--frozen-queue","32",
    "--shared-review-cache","/tmp/fabench-review-cache",
    "--fixed-document-manifest","/tmp/fabench-fixed-documents.json"];
  const admitted = formalArguments([...basic,...extra],PKG_ROOT);
  for(let i=0;i<extra.length;i+=2) {
    assert.equal(admitted.selected[extra[i]!.slice(2)],extra[i+1]);
    assert.ok(admitted.args.includes(extra[i]!));
  }
  assert.equal(formalArguments([...basic,"--frozen-workers","8"],PKG_ROOT).selected["frozen-workers"],"8");
  assert.equal(formalArguments([...basic,'--frozen-queue','1280'],PKG_ROOT).selected['frozen-queue'],'1280');
  for(const [key,value] of [["frozen-workers","0"],["frozen-workers","33"],["frozen-queue","0"],["frozen-queue","1.5"]])
    assert.throws(()=>formalArguments([...basic,`--${key}`,value!],PKG_ROOT),/must be/);
  assert.throws(()=>formalArguments([...basic,...extra,"--content-processing","whole-document"],PKG_ROOT),/requires single-pass/);
  assert.throws(()=>formalArguments([...basic,"--retrieval-profile","baseline","--frozen-workers","2"],PKG_ROOT),/require quality-v1/);
});

test('shared admission records explicit acquisition operating settings',{skip:needsFormalSet},()=>{
  const search=formalArguments([...basic,'--search-concurrency','32'],PKG_ROOT);
  assert.equal(search.selected['search-concurrency'],'32');
  for(const bad of ['0','-1','1.5','NaN'])assert.throws(()=>formalArguments([...basic,'--search-concurrency',bad],PKG_ROOT),/positive safe integer/);
  assert.throws(()=>formalArguments([...basic,'--retrieval-profile','baseline','--search-concurrency','32'],PKG_ROOT),/requires quality-v1/);
  const flags=['--fetch-concurrency','96','--reader-concurrency','64','--reader-rpm','480','--page-dispatch-concurrency','128'];
  const result=formalArguments([...basic,...flags],PKG_ROOT);
  for(let i=0;i<flags.length;i+=2)assert.equal(result.selected[flags[i]!.slice(2)],flags[i+1]);
  for(const flag of flags.filter((_,i)=>i%2===0)){
    for(const bad of ['0','-1','1.5','NaN'])assert.throws(()=>formalArguments([...basic,flag,bad],PKG_ROOT),/positive safe integer/);
    assert.throws(()=>formalArguments([...basic,'--retrieval-profile','baseline',flag,'2'],PKG_ROOT),/acquisition settings require quality-v1/);
  }
});

test('shared admission forwards and validates the model input cap',{skip:needsFormalSet},()=>{
  assert.equal(formalArguments([...basic,'--max-input-tokens','229376'],PKG_ROOT).selected['max-input-tokens'],'229376');
  for(const bad of ['-1','1.5','NaN','9007199254740992'])
    assert.throws(()=>formalArguments([...basic,'--max-input-tokens',bad],PKG_ROOT),/non-negative safe integer/);
});

test('mixed admits unchanged DS forecast/reviewer settings and requires both retrieval resources',{skip:needsFormalSet},()=>{
  const args=['--llm','deepseek:deepseek-flash','--settings','mixed','--conc','4','--leak-llm','deepseek:deepseek-flash'];
  const selected=formalArguments(args,PKG_ROOT).selected;
  assert.equal(selected['review-effort'],'low');assert.equal(selected.effort,undefined);
  assert.equal(selected['max-tool-calls'],'100');assert.equal(selected['max-results-per-search'],'20');
  assert.equal(selected['frozen-search-delivery'],'lead');
  assert.throws(()=>formalArguments(args.slice(0,-2),PKG_ROOT),/leak-llm/);
  assert.throws(()=>formalArguments([...args,'--retrieval-profile','baseline'],PKG_ROOT),/both requires quality-v1/);
  const custom=[...args,'--profile','custom','--questions-file','/tmp/q','--grading-file','/tmp/g'];
  assert.equal(formalArguments(custom,PKG_ROOT).selected['review-effort'],'low');
});

test('both and mixed admit the same reviewed retrieval for all supported subscription models',()=>{
  for (const llm of ['claude:claude-opus-5','claude:claude-opus-5-5','codex:gpt-6-astra','codex:gpt-6-sol','codex:gpt-5.6-sol','codex-personal:gpt-5.6-sol']) {
    const base=['--profile','custom','--questions-file','questions.jsonl','--grading-file','grading.jsonl',
      '--llm',llm,'--conc','4','--leak-llm','deepseek:deepseek-flash','--review-thinking','enabled','--review-effort','low',
      ...(llm.includes('sol')?['--effort','high']:[])];
    const both=formalArguments([...base,'--settings','both'],PKG_ROOT);
    assert.deepEqual(formalArguments([...base,'--settings','mixed'],PKG_ROOT),both);
    assert.equal(both.selected.settings,'both');
    assert.equal(both.selected['frozen-search-delivery'],'lead');
    assert.throws(()=>formalArguments([...base,'--settings','both','--leak-filter','0'],PKG_ROOT));
    assert.throws(()=>formalArguments([...base,'--settings','both,mixed'],PKG_ROOT),/Duplicate experiment arms/);
    assert.throws(()=>formalArguments([...base,'--settings','frozen+web-filter'],PKG_ROOT));
  }
});


test('retired n+n merge is rejected by shared admission even for API custom profiles',()=>{
  const base=['--profile','custom','--questions-file','q.jsonl','--grading-file','g.jsonl',
    '--llm','deepseek:deepseek-flash','--conc','10','--leak-llm','deepseek:deepseek-flash'];
  for (const arm of ['frozen+web-filter','web+frozen','frozen+backsearch+web-filter+expand','both+expand'])
    assert.throws(()=>formalArguments([...base,'--settings',arm],PKG_ROOT),/removed|cannot be combined/);
});


test("frozen/acquisition diagnostics do not require unused forecasting model credentials", () => {
  const report = checkEnvironment(PKG_ROOT, [], {
    diagnosticKind: "retrieval-validation", diagnosticModel: "unused:model", diagnosticUsesModel: false,
  });
  assert.equal(report.checks.find(c => c.name === "configured_api_resources")?.ok, true);
  assert.equal(report.checks.find(c => c.name === "question_inputs")?.ok, true);
  assert.deepEqual(report.providers, []);
});

test("a direct launch on the shared server is refused by its parsed arguments, not by the process argv or the host", (t) => {
  const release = mkdtempSync(join(tmpdir(), "current-release-"));
  const lifecycle = projectEnv("FABENCH_SHARED_LIFECYCLE"), argv = process.argv;
  t.after(() => {
    rmSync(release, { recursive: true, force: true });
    process.argv = argv;
    if (lifecycle === undefined) clearProjectEnv("FABENCH_SHARED_LIFECYCLE");
    else process.env.FABENCH_SHARED_LIFECYCLE = lifecycle;
  });
  clearProjectEnv("FABENCH_SHARED_LIFECYCLE");
  const custom = ["--preset", "custom", "--questions-file", SYNTHETIC_QUESTIONS,
    "--grading-file", SYNTHETIC_GRADING, "--llm", "x:y", "--settings", "none", "--n", "2"];
  const run = (extra: string[]) => ({ raw: [...custom, ...extra], conditionPreview: extra.includes("--condition-preview-file") });
  // `release` stands in for the shared current release, so this runs the same on any host.
  assert.throws(() => loadAdmissionReceipt(PKG_ROOT, { ...run([]), currentRelease: release }), /must use tools\/run-shared-experiment.sh/);
  process.argv = [argv[0]!, "forecast-value.ts", "--condition-preview-file", "/tmp/preview.json"];
  assert.throws(() => loadAdmissionReceipt(PKG_ROOT, { ...run([]), currentRelease: release }), /must use tools\/run-shared-experiment.sh/,
    "a preview flag elsewhere in the process does not admit this run");
  assert.equal(loadAdmissionReceipt(PKG_ROOT, { ...run(["--condition-preview-file", "/tmp/p.json"]), currentRelease: release }), null);
  assert.equal(loadAdmissionReceipt(PKG_ROOT, { ...run([]), currentRelease: release, offline: true }), null);
  assert.equal(loadAdmissionReceipt(PKG_ROOT, { ...run([]), currentRelease: join(release, "absent") }), null, "not the shared server");
  t.mock.method(console, "log", () => {});
  const options = readForecastOptions(custom);
  assert.throws(() => loadForecastQuestions(options, { currentRelease: release }), /must use tools\/run-shared-experiment.sh/);
  assert.equal(loadForecastQuestions(options, { currentRelease: release, offline: true }).questions.length, 2);
  const preview = readForecastOptions([...custom, "--condition-preview-file", "/tmp/p.json"]);
  assert.equal(loadForecastQuestions(preview, { currentRelease: release }).questions.length, 2);
});
