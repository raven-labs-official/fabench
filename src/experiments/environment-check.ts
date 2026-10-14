import {armUsesFrozen, armUsesWebFilter} from './experiment-identity.js';
/** Check usable inputs and shared resources; the operator chooses the experiment checkout. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostname, userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { PKG_ROOT } from "../paths.js";
import { codeCommit } from "../code-version.js";
import { experimentCodeIdentity } from "./registry.js";
import { RATE_POLICY, SHARED_RATE_DB, SharedRateLimiter } from "../llm/shared-rate-limit.js";
import { validateReviewerThinking, validateReviewerEffort, validateShadowReviewEffort } from "../llm/reviewer-thinking.js";
import { createLlmClient } from "../llm/benchmark-providers.js";
import { buildJevRequest, JEV_MODEL } from "../llm/jev.js";
import { createSearchProvider } from "../retrieval/search-providers.js";
import { assertQualityCorpus } from "../retrieval/quality-profile.js";
import { CorpusStore } from "../../vendor/retrieval-infra/src/corpus/store.js";
import { corpusRetrievalIdentity } from "../corpus/retrieval-identity.js";
import { loadQuestionPool } from "../datasets/question-pool.js";
import { normalizeQuestionId, selectedQuestionIds } from "./question-selection.js";
import { parseForecastArguments } from "./forecast/options.js";
import { applyEnvironmentDefaults, formatValue, type ParameterSummary, resolveRunParameters, type ResolveContext } from "./params/resolve.js";
import { CURRENT_RELEASE, FROZEN_SHARED_CACHE, SHARED_REGISTRY_PATH, SHARED_RESULTS_DIR, SITE_NAME, TEAM_CONFIG_DIR } from "../path-config.js";
import { projectEnv, projectEnvName } from "../env-names.js";
export const FORMAL = Object.freeze({ id: "formal-232", count: 232 });
const ATTESTATION = ".git/raven-release-environment.json";
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const hashFile = (p: string) => sha(readFileSync(p));
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Check = { name: string; ok: boolean; detail: string };

/** Hash installed dependency bytes and symlink targets; no package-manager mutation at startup. */
export function dependencyDigest(root: string): string {
  return directoryDigest(join(root,"node_modules"));
}
function directoryDigest(root: string, ignorePythonCache = false): string {
  const hash = createHash("sha256");
  function visit(dir: string) {
    for (const entry of readdirSync(dir).sort()) {
      if (ignorePythonCache && (entry === "__pycache__" || entry.endsWith(".pyc"))) continue;
      const path = join(dir, entry); const stat = lstatSync(path);
      hash.update(path.slice(root.length)).update("\0");
      if (stat.isSymbolicLink()) hash.update("link:" + readlinkSync(path));
      else if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) hash.update(readFileSync(path));
      hash.update("\0");
    }
  }
  visit(root);
  return hash.digest("hex");
}
function sharedValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(join(TEAM_CONFIG_DIR, "common.env"), "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) values[m[1]!] = m[2]!.trim().replace(/^['"]|['"]$/g, "");
  }
  return values;
}
function releasePython(root: string, values: Record<string, string>) {
  const local = join(root, ".venv/bin/python");
  return existsSync(local) ? local : values.HTMLDATE_PYTHON;
}
function externalEnvironment(values: Record<string, string>, root: string) {
  const python = releasePython(root, values);
  if (!python || !python.startsWith("/")) throw new Error("common.env must pin an absolute HTMLDATE_PYTHON");
  const pythonInfo = JSON.parse(execFileSync(python, ["-c",
    "import sys,sysconfig,json,importlib.metadata; print(json.dumps({'version':sys.version.split()[0],'htmldate':importlib.metadata.version('htmldate'),'trafilatura':importlib.metadata.version('trafilatura'),'site_packages':sysconfig.get_path('purelib')}))"],
    { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }));
  const corpus = projectEnv("FABENCH_CORPUS_DB", values);
  if (!corpus) throw new Error("common.env must pin FABENCH_CORPUS_DB");
  const st = statSync(corpus);
  if (!st.isFile() || st.size < 1_000_000) throw new Error("Frozen corpus is missing or truncated");
  const localPython = python === join(root,".venv/bin/python");
  // A staged release is renamed after testing. Record its relative environment
  // path while hashing the same executable/package bytes before and after rename.
  return { python: { path: localPython ? ".venv/bin/python" : realpathSync(python),
      executable_sha256: hashFile(realpathSync(python)), ...pythonInfo,
      site_packages: localPython ? pythonInfo.site_packages.slice(root.length + 1) : pythonInfo.site_packages,
      packages_sha256: directoryDigest(pythonInfo.site_packages,true) },
    browser: existsSync(join(root,'.playwright')) ? { path:'.playwright', files_sha256:directoryDigest(join(root,'.playwright')) } : null,
    corpus: { path: realpathSync(corpus), size: st.size, mtime_ms: st.mtimeMs,
      identity_method: "shared file path, size and modification time; runner opens read-only; not a full content hash" } };
}
export function writeReleaseAttestation(root: string) {
  const info = {
    schema: "raven.release-environment.v1", checked_at_utc: new Date().toISOString(),
    commit: codeCommit(root), node: process.version, platform: process.platform, arch: process.arch,
    source: experimentCodeIdentity(root).source_fingerprint_sha256,
    lockfile_sha256: hashFile(join(root, "pnpm-lock.yaml")), dependencies_sha256: dependencyDigest(root),
    common_config_sha256: hashFile(join(TEAM_CONFIG_DIR, "common.env")), external: externalEnvironment(sharedValues(),root),
    formal: validateFormalFiles(root), api_admission_policy: RATE_POLICY,
  };
  writeFileSync(join(root, ATTESTATION), JSON.stringify(info, null, 2) + "\n", { mode: 0o640 });
  return info;
}
export function validateFormalFiles(root: string) {
  const dir = join(root, "question-making/curated");
  const questionPath = join(dir, "raven_model_test.jsonl");
  const gradingPath = join(dir, "raven_grading_key.jsonl");
  const loaded = loadQuestionPool(questionPath, gradingPath);
  if (loaded.questions.length !== FORMAL.count)
    throw new Error("formal-232 requires 232 questions; use --profile custom for other sets");
  return {
    id: FORMAL.id,
    count: loaded.questions.length,
    questions_sha256: loaded.identity.file_sha256,
    grading_sha256: loaded.identity.grading_file_sha256,
    prompt_batch_sha256: sha(JSON.stringify(loaded.questions.map(q => [q.question_id, q.forecast_prompt]))),
  };
}

/**
 * Resolve once through the parameter schema (src/experiments/params), apply the shared
 * platform's admission policies, then feed these exact arguments to the runner. The values are
 * the ones a direct run of the same arguments gets; admission only adds requirements.
 */
export function formalArguments(raw: string[], root: string, context: Omit<ResolveContext, "root"> = {}) {
  const resolved = resolveRunParameters(raw, { ...context, root });
  const profile = resolved.preset.admissionProfile;
  const value = (key: string) => resolved.value(key);
  const explicit = (key: string) => resolved.isExplicit(key);
  const text = (key: string) => (value(key) === null ? undefined : formatValue(value(key)));
  for (const key of ["registry", "registry_path", "condition_preview_file"])
    if (explicit(key)) throw new Error(`--${key.replaceAll("_", "-")} cannot bypass shared experiment admission`);
  const llm = text("llm") ?? "";
  if (!explicit("llm") || !/^[a-z0-9-]+:[^\s:]+$/i.test(llm))
    throw new Error("Explicit --llm provider:exact-model is required");
  if (!explicit("compare")) throw new Error("Explicit --settings is required");
  const compare = String(value("compare"));
  const ledger = value("ledger") === true, evidence = explicit("evidence_file"), effort = text("effort");
  if (llm.startsWith("jev:")) {
    if(llm!==`jev:${JEV_MODEL}` || compare!=="none" || explicit("effort") || ledger || evidence)
      throw new Error("Jev requires pinned jev:jev-1.13.0, none, no effort, and the reviewed prompt without added evidence");
  }
  const nativeSol=/^codex(?:-personal)?:gpt-5\.6-sol$/.test(llm) || llm==="codex:gpt-6-sol";
  const reviewedArms=/^(none|frozen|web-filter|both)(,(none|frozen|web-filter|both))*$/;
  if (llm === "codex:gpt-6-astra" || nativeSol) {
    if(nativeSol && effort!=="high") throw new Error("Sol requires explicit high effort");
    if (!reviewedArms.test(compare))
      throw new Error("Native Codex subscription supports only none, frozen, web-filter and both");
    if (explicit("effort") && !["low", "medium", "high", "xhigh", "max"].includes(effort!))
      throw new Error("Unsupported Astra effort; omit for the provider default");
    if (ledger || evidence)
      throw new Error("Native Codex subscription requires the reviewed structured forecast without added evidence");
  } else if (/^codex(?:-personal)?:/.test(llm))
    throw new Error("Unsupported native Codex model/account");
  if (/^claude:/.test(llm)) {
    if (!new Set(["claude:claude-opus-5","claude:claude-opus-5-5"]).has(llm) || !reviewedArms.test(compare))
      throw new Error("Claude subscription admits only pinned Opus models with none, frozen, web-filter or both");
    if (ledger || evidence)
      throw new Error("Claude requires the reviewed forecast without added evidence");
  }
  if ((llm==="codex:gpt-6-astra" || nativeSol || /^claude:/.test(llm)) && armUsesWebFilter(compare)) {
    if (!explicit("leak_llm") || value("leak_filter")===false)
      throw new Error("Subscription web-filter requires an explicit --leak-llm and enabled review");
  }
  if (!explicit("conc")) throw new Error("Explicit positive --conc is required");
  if (profile === "formal-232") {
    if (armUsesWebFilter(compare) && !explicit("leak_llm"))
      throw new Error("web-filter requires an explicit --leak-llm provider:exact-model");
    const selectedIds = selectedQuestionIds(text("ids"), text("ids_file"));
    if (selectedIds) {
      const valid = new Set(readFileSync(join(root,"question-making/curated/raven_model_test.jsonl"),"utf8")
        .trim().split("\n").map(s => normalizeQuestionId(JSON.parse(s).id)));
      for (const id of selectedIds)
        if (!valid.has(normalizeQuestionId(id)))
          throw new Error(`Subset contains an ID outside the formal 232 questions: ${id}`);
    }
  } else if (!value("questions_file") || !value("grading_file")) {
    throw new Error("Custom profile requires explicit question and grading files; no implicit legacy dataset");
  }
  const quality = value("retrieval_profile") === "quality-v1";
  const selected = resolved.selected;
  if ((selected["shared-frozen-cache"] || selected["frozen-global-slots"]) && !(armUsesFrozen(compare) && quality))
    throw new Error("--shared-frozen-cache requires quality-v1 frozen retrieval");
  if (compare.split(",").includes("both") && (!quality || !explicit("leak_llm") || value("frozen_archive_file") !== null))
    throw new Error("both requires quality-v1, explicit --leak-llm and no archive supplement");
  if (!["serper","brave","auto"].includes(text("search_provider")!))
    throw new Error("--search-provider must be serper, brave or auto");
  // Reviewer settings as the runner will receive them (a preset value that does not apply to
  // these arms is not passed on).
  const review = {
    compare, profile: selected["retrieval-profile"]!, model: selected["leak-llm"]!,
    fallback: selected["leak-fallback-llm"], filter: selected["leak-filter"],
  };
  const thinking = selected["review-thinking"], primaryEffort = selected["review-effort"];
  validateReviewerThinking(thinking, review);
  validateReviewerEffort(primaryEffort, { ...review, thinking });
  validateShadowReviewEffort(selected["shadow-review-effort"], { ...review, thinking, primaryEffort,
    processing: selected["content-processing"] });
  parseForecastArguments(resolved.args); // The runner's own checks, before any shared resource is touched.
  return { args: resolved.args, profile, preset: resolved.preset.name, selected: resolved.selected,
    parameters: resolved.summary(), warnings: resolved.warnings };
}

export function checkoutAdvisory(selected: string, current: string | null): string | null {
  return current && selected !== current
    ? `Selected experiment directory ${selected} differs from current ${current}; directory selection belongs to the experimenter.`
    : null;
}

export function checkEnvironment(root: string, raw: string[], options: { current?: string; diagnosticModel?: string; diagnosticKind?: 'reader-cleaning' | 'retrieval-validation'; diagnosticUsesModel?: boolean } = {}) {
  root = realpathSync(root);
  const checks: Check[] = [];
  const warnings: string[] = [];
  const current = options.current ?? CURRENT_RELEASE;
  const advisory = checkoutAdvisory(root, existsSync(current) ? realpathSync(current) : null);
  if (advisory) warnings.push(advisory);
  function check(name: string, fn: () => string) {
    try { checks.push({ name, ok: true, detail: fn() }); }
    catch (error) { checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  }
  let normalized: { profile: string; args: string[]; selected: Record<string, string>; preset?: string;
    parameters?: ParameterSummary; warnings?: string[] } | undefined;
  let questionFiles: ReturnType<typeof validateFormalFiles> | ReturnType<typeof loadQuestionPool>["identity"] | null = null;
  check("shared_paths_and_config", () => {
    const expected: Record<string,string> = { FABENCH_TEAM_CONFIG_DIR:TEAM_CONFIG_DIR, FABENCH_COMMON_ENV_FILE:join(TEAM_CONFIG_DIR,"common.env"),
      FABENCH_TEAM_ENV_FILE:join(TEAM_CONFIG_DIR,"team.env"), FABENCH_PROGRESS_ENV_FILE:join(TEAM_CONFIG_DIR,"progress.env"),
      FABENCH_EXPERIMENT_REGISTRY:SHARED_REGISTRY_PATH, FABENCH_SHARED_RESULTS_ROOT:SHARED_RESULTS_DIR, FABENCH_API_ADMISSION_DB:SHARED_RATE_DB };
    for (const [key, path] of Object.entries(expected)) {
      const inherited = projectEnv(key);
      if (inherited && resolve(inherited) !== path) throw new Error(`${projectEnvName(key)} overrides the shared environment`);
    }
    for (const p of [join(TEAM_CONFIG_DIR,"common.env"),join(TEAM_CONFIG_DIR,"team.env"),join(TEAM_CONFIG_DIR,"progress.env")]) accessSync(p, constants.R_OK);
    accessSync(SHARED_REGISTRY_PATH, constants.R_OK | constants.W_OK);
    accessSync(SHARED_RESULTS_DIR, constants.W_OK);
    return "Shared configuration, registry and results are accessible";
  });
  check("experiment_arguments", () => {
    if (options.diagnosticModel) {
      if (raw.length || !/^[a-z0-9-]+:[a-zA-Z0-9._/-]+$/.test(options.diagnosticModel)) throw new Error("Invalid diagnostic model or forecast arguments");
      normalized = { profile: options.diagnosticKind ?? "reader-cleaning", args: [], selected: { llm: options.diagnosticModel } };
      return normalized.profile;
    }
    const admitted = formalArguments(raw, root);
    normalized = admitted;
    applyEnvironmentDefaults(resolveRunParameters(admitted.args, { root }));
    return `${admitted.profile} (preset ${admitted.preset})`;
  });
  check("question_inputs", () => {
    if (!normalized) throw new Error("No valid experiment arguments");
    if (options.diagnosticModel) return "Component diagnostic; no forecast question set";
    questionFiles = normalized.profile === "formal-232"
      ? validateFormalFiles(root)
      : loadQuestionPool(normalized.selected["questions-file"]!, normalized.selected["grading-file"]).identity;
    return "Readable question/answer files with aligned IDs, valid dates and input contracts; actual hashes recorded";
  });
  check("retrieval_corpus", () => {
    if (!normalized) throw new Error("No admitted experiment arguments");
    if (!armUsesFrozen(normalized.selected.settings)) {
      if(normalized.selected["shared-frozen-cache"]) throw new Error("--shared-frozen-cache requires a frozen retrieval arm");
      return "No frozen source selected";
    }
    const path = normalized.selected["frozen-corpus-file"] ?? projectEnv("FABENCH_CORPUS_DB");
    if (!path) throw new Error("Frozen retrieval requires --frozen-corpus-file or shared FABENCH_CORPUS_DB");
    const identity = corpusRetrievalIdentity(path);
    if(normalized.selected["shared-frozen-cache"]) {
      if(resolve(normalized.selected["shared-frozen-cache"]!)!==FROZEN_SHARED_CACHE)
        throw new Error('Shared experiments must use the admitted global frozen cache path');
      const store=new CorpusStore(path,'concept','auto',{sharedFrozenCachePath:resolve(normalized.selected["shared-frozen-cache"]!),sharedFrozenCacheSlots:Number(normalized.selected["frozen-global-slots"])});
      store.close(); // Verify index identity, writable shared cache and pinned limits before model calls.
    }
    if (normalized.selected["retrieval-profile"] === "quality-v1") {
      const { questions } = loadQuestionPool(normalized.selected["questions-file"]!,normalized.selected["grading-file"]);
      const anchors = questions.map(q => q.as_of_date ?? q.resolution_date);
      assertQualityCorpus(identity, anchors);
    }
    return JSON.stringify(identity);
  });
  const providerMetadata: unknown[] = [];
  check("configured_api_resources", () => {
    if (!normalized) throw new Error("No admitted experiment arguments");
    if (options.diagnosticUsesModel === false) return "No model resource required for this component diagnostic";
    for (const key of ["llm", ...(armUsesWebFilter(normalized.selected.settings) ? ["leak-llm", "leak-fallback-llm"] : [])]) {
      const spec = normalized.selected[key]; if (!spec) continue;
      const i=spec.indexOf(":"); if(i<1 || !spec.slice(i+1)) throw new Error(`${key} must name an explicit provider:model`);
      const client=createLlmClient(spec.slice(0,i),spec.slice(i+1));
      if(spec===`jev:${JEV_MODEL}`) {
        const file=normalized.selected["questions-file"];
        if(!file)throw new Error("Jev requires an explicit question file");
        // Validate every input-only numeric reference before any billable call.
        for(const line of readFileSync(file,"utf8").trim().split("\n")) {
          const q=JSON.parse(line);
          const prepared=buildJevRequest({system:"Follow the historical information boundary and JSON response contract in the question.\n\nNo retrieval tools are available for this forecast.",prompt:q.prompt});
          if((prepared.reference?.unit??null)!==q.numeric_target_unit)throw new Error(`Jev numeric target mismatch: ${q.id}`);
        }
      }
      providerMetadata.push({role:key,id:client.id,...client.traceMetadata});
    }
    if (armUsesWebFilter(normalized.selected.settings)) createSearchProvider(normalized.selected["search-provider"]??"serper");
    return "Configured model/search credentials are present; no inference or credential values emitted";
  });
  let apiState: ReturnType<SharedRateLimiter["snapshot"]> | null = null;
  check("shared_api_admission", () => {
    if (projectEnv("FABENCH_API_ADMISSION_DB") !== SHARED_RATE_DB) throw new Error("Shared API admission must be enabled by the launcher");
    const limiter = new SharedRateLimiter(SHARED_RATE_DB);
    try { apiState = limiter.snapshot(); } finally { limiter.close(); }
    return RATE_POLICY.version;
  });
  let running: unknown[] = [];
  try {
    const db = new DatabaseSync(SHARED_REGISTRY_PATH, {readOnly:true});
    running = db.prepare("SELECT run_id,owner,tag,status,last_heartbeat_utc,config_json FROM runs WHERE status IN ('running','sleeping')").all().map((r:any)=>{
      const config=JSON.parse(r.config_json); const {config_json,...rest}=r;
      return {...rest, commit:config.code_identity?.git_commit??null, same_code_commit:config.code_identity?.git_commit===codeCommit(root),
        formal_profile:config.environment_admission?.profile === FORMAL.id,
        shared_admission:config.api_admission_policy?.version===RATE_POLICY.version,
        note:"Existing processes retain their launch environment; no automatic restart or condition change"};
    }); db.close();
  } catch { warnings.push("Could not inspect existing run metadata"); }
  return {schema:"raven.environment-check.v1",checked_at_utc:new Date().toISOString(),ok:checks.every(c=>c.ok),
    owner:userInfo().username,host:hostname(),release:root,commit:codeCommit(root),
    directory_policy:"operator-selected", runtime:{node:process.version,platform:process.platform,arch:process.arch},
    checks,warnings:[...warnings,...(normalized?.warnings ?? [])],running,profile:normalized?.profile,
    preset:normalized?.preset ?? null, effective_args:normalized?.args,
    conditions:normalized?.selected, parameters:normalized?.parameters ?? null, question_files:questionFiles, api_admission_policy:RATE_POLICY,
    providers:providerMetadata, api_state:apiState as ReturnType<SharedRateLimiter["snapshot"]> | null,
    contract_sha256:sha(JSON.stringify({questionFiles,policy:RATE_POLICY})),
  };
}
/**
 * The admission receipt of a shared run, or null outside the shared lifecycle. Outside it, a
 * real launch on the shared server (where the current release exists) is refused; the decision reads the run's own parsed arguments (a
 * condition preview) or an offline mode the caller declares (tests, tools that never call a
 * model), not the process's global argv.
 */
export function loadAdmissionReceipt(root: string, run: {
  raw: readonly string[]; conditionPreview: boolean; offline?: boolean; currentRelease?: string;
}) {
  if (projectEnv("FABENCH_SHARED_LIFECYCLE") !== "1") {
    if (existsSync(run.currentRelease ?? CURRENT_RELEASE) && !run.conditionPreview && !run.offline)
      throw new Error(`${SITE_NAME} experiments must use tools/run-shared-experiment.sh; only offline condition previews may bypass admission`);
    return null;
  }
  const file=projectEnv("FABENCH_ENVIRONMENT_RECEIPT");
  if (!file) throw new Error("Shared run has no environment admission receipt");
  const receipt=readJson(file);
  if (!receipt.ok || receipt.release!==realpathSync(root))
    throw new Error("Resource/input check failed or belongs to another experiment directory");
  const actual = formalArguments([...run.raw],root).args;
  if (!same(actual,receipt.effective_args)) throw new Error("Runner arguments differ from the checked environment receipt");
  return receipt;
}
async function main() {
  const argv=process.argv.slice(2);
  if (argv[0]==="verify-runtime") {
    const root=realpathSync(argv[1]??PKG_ROOT), attestation=readJson(join(root,ATTESTATION));
    if (!same(externalEnvironment(sharedValues(),root),attestation.external)) throw new Error("Published Python/corpus differs from tested staging environment");
    console.log("Published external runtime matches attestation"); return;
  }
  if (argv[0]==="attest") { writeReleaseAttestation(realpathSync(argv[1]??PKG_ROOT)); console.log("Release environment attested"); return; }
  const separator=argv.indexOf("--");
  if (separator<0) throw new Error("usage: environment-check.ts --output receipt.json -- <experiment args>");
  const out=argv[argv.indexOf("--output")+1];
  if (!out || argv.indexOf("--output")<0) throw new Error("--output is required");
  const report=checkEnvironment(PKG_ROOT,argv.slice(separator+1));
  mkdirSync(dirname(resolve(out)),{recursive:true,mode:0o2750});
  writeFileSync(out,JSON.stringify(report,null,2)+"\n",{mode:0o640});
  for (const c of report.checks) console.log(`[${c.ok?"OK":"FAIL"}] ${c.name}: ${c.detail}`);
  // Parameter warnings (ignored environment values, values the chosen arms do not use) go to
  // stderr as well as the receipt, so they are not lost in the check output.
  const parameterWarnings = new Set(report.parameters?.warnings ?? []);
  for (const warning of report.warnings)
    (parameterWarnings.has(warning) ? console.error : console.log)(`[WARN] ${warning}`);
  for (const item of report.running as any[]) console.log(`[RUN] ${item.owner} ${item.run_id} same_code=${item.same_code_commit} formal_profile=${item.formal_profile} shared_throttle=${item.shared_admission}`);
  for (const item of report.api_state?.resources ?? []) console.log(`[API] ${item.resource} shared_cap=${item.cap} gap_ms=${item.gap_ms} cooldown_until=${item.cooldown_until ? new Date(Number(item.cooldown_until)).toISOString() : "none"}`);
  console.log(`Environment receipt: ${resolve(out)}`);
  if (!report.ok) process.exitCode=1;
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
