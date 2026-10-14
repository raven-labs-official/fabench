/**
 * Frozen oracle: the argument handling of commit 733fec5, before the layered parameter
 * system. The golden identity tests build conditions through these functions and through the
 * new resolver and require byte-identical results. Runtime code never imports this file. Do
 * not edit it to follow later changes; a deliberate identity change updates the golden tests.
 */
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { planQuery, type QueryAliases } from "../../../../vendor/retrieval-infra/src/corpus/query-plan.js";
import { defaultFrozenWorkers } from "../../../../vendor/retrieval-infra/src/corpus/frozen-execution.js";
import { frozenCacheSlots } from "../../../../vendor/retrieval-infra/src/corpus/frozen-route-cache.js";
import { validateReviewerEffort, validateReviewerThinking, validateShadowReviewEffort } from "../../../llm/reviewer-thinking.js";
import { JEV_MODEL } from "../../../llm/jev.js";
import { FROZEN_SHARED_CACHE, SHARED_RESULTS_DIR } from "../../../path-config.js";
import { RESULTS_DIR } from "../../../paths.js";
import { DEFAULT_MAX_TOOL_CALLS } from "../../../predictors/agentic-search.js";
import { frozenSearchDeliveryDefault, parseFrozenSearchDelivery } from "../../../predictors/frozen-search-preview.js";
import { parseToolDelivery } from "../../../predictors/tool-content-pages.js";
import { type DateGateMode } from "../../../retrieval/search-backend.js";
import { armUsesFrozen, armUsesWebFilter, assertSupportedArmComposition } from "../../experiment-identity.js";
import { normalizeQuestionId, selectedQuestionIds } from "../../question-selection.js";

const CONCURRENCY_FLAGS = {
  question_concurrency: "conc",
  model_concurrency: "llm-concurrency",
  frozen_workers: "frozen-workers",
  frozen_queue: "frozen-queue",
  candidate_concurrency: "candidate-concurrency",
  review_concurrency: "review-concurrency",
  cleaning_concurrency: "cleaning-concurrency",
  search_concurrency: "search-concurrency",
  fetch_concurrency: "fetch-concurrency",
  reader_concurrency: "reader-concurrency",
  reader_rpm: "reader-rpm",
  page_dispatch_concurrency: "page-dispatch-concurrency",
} as const;

function legacyExpandConcurrencyArguments(argv: string[]): string[] {
  const args = argv.flatMap((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    return match ? [`--${match[1]}`, match[2]!] : [arg];
  });
  const index = args.indexOf("--concurrency-file");
  if (index < 0) return args;
  if (args.lastIndexOf("--concurrency-file") !== index)
    throw new Error("Duplicate argument --concurrency-file");
  const file = args[index + 1];
  if (!file || file.startsWith("--"))
    throw new Error("--concurrency-file requires a file path");
  const config: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Concurrency configuration must be a JSON object");
  const { schema, ...limits } = config as Record<string, unknown>;
  if (schema !== "raven.concurrency.v1")
    throw new Error("Expected concurrency schema raven.concurrency.v1");
  args.splice(index, 2);
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(CONCURRENCY_FLAGS, key))
      throw new Error(`Unknown concurrency setting: ${key}`);
    if (!Number.isSafeInteger(value) || Number(value) < 1)
      throw new Error(`${key} must be a positive safe integer`);
    const flag = CONCURRENCY_FLAGS[key as keyof typeof CONCURRENCY_FLAGS];
    if (!args.includes(`--${flag}`)) args.push(`--${flag}`, String(value));
  }
  return args;
}

function legacyRetrievalProfile(argv: string[], defaultDirectory: string) {
  const value = (flag: string) => {
    const i = argv.indexOf(`--${flag}`);
    if (i < 0) return undefined;
    if (!argv[i + 1] || argv[i + 1]!.startsWith('--')) throw new Error(`--${flag} requires a value`);
    return argv[i + 1];
  };
  const name = value('retrieval-profile') ?? 'quality-v1';
  if (!['baseline', 'quality-v1'].includes(name)) throw new Error('--retrieval-profile must be baseline or quality-v1');
  const enabled = name === 'quality-v1';
  const browser = value('browser-fallback');
  if (browser !== undefined && !['0','1'].includes(browser)) throw new Error('--browser-fallback must be 0 or 1');
  if (!enabled && browser === '1') throw new Error('--browser-fallback requires quality-v1');
  const concurrency = (flag: string) => {
    const raw = value(flag); if (raw === undefined) return undefined;
    const n = Number(raw); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${flag} must be a positive safe integer`); return n;
  };
  const frozenWorkers=Number(value('frozen-workers')??defaultFrozenWorkers()),frozenQueue=Number(value('frozen-queue')??64);
  const sharedFrozenCachePath=value('shared-frozen-cache'),sharedFrozenCacheSlots=concurrency('frozen-global-slots');
  if(sharedFrozenCacheSlots!==undefined&&(!sharedFrozenCachePath||sharedFrozenCacheSlots>32))throw new Error('--frozen-global-slots requires a shared cache and 1–32 slots');
  if(!Number.isSafeInteger(frozenWorkers)||frozenWorkers<1||frozenWorkers>32)throw new Error('--frozen-workers must be 1–32');
  if(!Number.isSafeInteger(frozenQueue)||frozenQueue<1)throw new Error('--frozen-queue must be a positive safe integer');
  if(!enabled&&(value('frozen-workers')!==undefined||value('frozen-queue')!==undefined||sharedFrozenCachePath))throw new Error('frozen worker options require quality-v1');
  const candidateConcurrency = concurrency('candidate-concurrency'), reviewConcurrency = concurrency('review-concurrency'), cleaningConcurrency = concurrency('cleaning-concurrency'), searchHttpConcurrency = concurrency('search-concurrency');
  const acquisition = {
    fetchConcurrency: concurrency('fetch-concurrency'), readerConcurrency: concurrency('reader-concurrency'),
    readerRpm: concurrency('reader-rpm'), dispatchConcurrency: concurrency('page-dispatch-concurrency'),
  };
  if (!enabled && Object.values(acquisition).some(value => value !== undefined)) throw new Error('acquisition settings require quality-v1');
  const scheduling = value('retrieval-scheduling');
  if (scheduling !== undefined && !['rolling','batches'].includes(scheduling)) throw new Error('--retrieval-scheduling must be rolling or batches');
  if (!enabled && (candidateConcurrency !== undefined || reviewConcurrency !== undefined || cleaningConcurrency !== undefined || searchHttpConcurrency !== undefined || scheduling !== undefined)) throw new Error('retrieval scheduling requires quality-v1');
  const wikiCachePath=value('wiki-cache'),wikiManifestFile=value('wiki-manifest'),wikiIndexFile=value('wiki-index'),queryExpansionModel=value('query-expansion-model');
  const contentProcessing=value('content-processing')??(enabled?'single-pass':'whole-document');
  if(!['whole-document','integrated','single-pass'].includes(contentProcessing))throw new Error('--content-processing must be single-pass, whole-document or integrated');
  // Single-pass review produces the approved summary that formal web runs hand the model.
  const searchDelivery=value('search-delivery')??(enabled&&contentProcessing==='single-pass'?'summary':'fulltext');
  if(!['fulltext','summary'].includes(searchDelivery)||searchDelivery==='summary'&&(!enabled||contentProcessing!=='single-pass'))throw new Error('--search-delivery summary requires quality-v1 single-pass');
  const sourceManifestFile=value('source-manifest'),sharedCacheDirectory=value('shared-review-cache'),fixedDocumentManifestFile=value('fixed-document-manifest');
  const sharedPageCacheDirectory=value('shared-page-cache');
  if(sharedPageCacheDirectory&&(!enabled||contentProcessing!=='single-pass'||!sharedCacheDirectory||sourceManifestFile||fixedDocumentManifestFile))throw new Error('--shared-page-cache requires single-pass quality profile and --shared-review-cache; pinned manifests must be separate');
  if((sharedCacheDirectory||fixedDocumentManifestFile)&&(!enabled||contentProcessing!=='single-pass'))throw new Error('Shared/fixed page caching requires single-pass quality profile');
  if(sourceManifestFile&&(!enabled||contentProcessing!=='single-pass'))throw new Error('--source-manifest requires single-pass content processing');
  if(wikiIndexFile&&!wikiManifestFile)throw new Error('--wiki-index requires --wiki-manifest');
  if(wikiManifestFile&&!wikiCachePath)throw new Error('--wiki-manifest requires --wiki-cache');
  if(!enabled&&(wikiCachePath||wikiManifestFile||wikiIndexFile||queryExpansionModel||contentProcessing!=='whole-document'))throw new Error('architecture options require quality-v1');
  if(queryExpansionModel&&!/^[a-z0-9_-]+:.+/.test(queryExpansionModel))throw new Error('query expansion model requires provider:model');
  const directory = value('retrieval-evidence-dir'), aliasFile = value('retrieval-aliases-file');
  if (!enabled && (directory || aliasFile)) throw new Error('retrieval evidence/aliases options require quality-v1');
  if (enabled) {
    for (const flag of ['date-gate', 'leak-availability-policy', 'web-search-failure-limit', 'web-zero-served-limit']) {
      if (argv.includes(`--${flag}`)) throw new Error(`--${flag} configures the baseline; quality-v1 uses its recorded evidence policy`);
    }
    if (value('leak-filter') === '0') throw new Error('quality-v1 requires the evidence reviewer');
    if (value('fetch-chars') && Number(value('fetch-chars')) !== 0) throw new Error('quality-v1 benchmark tools require --fetch-chars 0 for full reviewed text');
  }
  const aliases: QueryAliases[] = aliasFile ? JSON.parse(readFileSync(aliasFile, 'utf8')) : [];
  if (!Array.isArray(aliases)) throw new Error('retrieval aliases must be an array');
  planQuery('', () => 0, { aliases }); // Validate provenance and bounded groups before paid calls.
  return { searchDelivery: searchDelivery as 'fulltext'|'summary', name: name as 'baseline' | 'quality-v1', enabled,
    wikiCachePath:wikiCachePath?resolve(wikiCachePath):undefined, wikiManifestFile:wikiManifestFile?resolve(wikiManifestFile):undefined, wikiIndexFile:wikiIndexFile?resolve(wikiIndexFile):undefined, queryExpansionModel, contentProcessing:contentProcessing as 'whole-document'|'integrated'|'single-pass',sourceManifestFile:sourceManifestFile?resolve(sourceManifestFile):undefined,
    sharedCacheDirectory:sharedCacheDirectory?resolve(sharedCacheDirectory):undefined,sharedPageCacheDirectory:sharedPageCacheDirectory?resolve(sharedPageCacheDirectory):undefined,fixedDocumentManifestFile:fixedDocumentManifestFile?resolve(fixedDocumentManifestFile):undefined,
    frozenWorkers,frozenQueue,sharedFrozenCacheSlots,sharedFrozenCachePath:sharedFrozenCachePath?resolve(sharedFrozenCachePath):undefined,candidateConcurrency, reviewConcurrency, cleaningConcurrency, searchHttpConcurrency, acquisition, scheduling: scheduling as 'rolling' | 'batches' | undefined,
    directory: enabled ? resolve(directory ?? defaultDirectory) : null, aliases };
}

const DEFAULT_COMPARE = "none,frozen,both";

function backsearchCorpora(value: string): string[] {
  const raw = value
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const bad = raw.filter((c) => c === "cc_sec");
  if (bad.length)
    throw new Error(
      `--backsearch-corpus cc_sec is not allowed: that corpus is gated on filing date, not ` +
        `crawl date, so its documents do not carry the physical-age guarantee the rest of ` +
        `this benchmark relies on (docs/archive/research/validity-through-20260907.md section 3). ` +
        `Run it as its own labelled arm if you want to study it.`,
    );
  return raw;
}

export function legacyReadForecastOptions(raw = process.argv.slice(2)) {
  const argv = legacyExpandConcurrencyArguments(raw);
  const arg = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    return value;
  };
  const n = Number(arg("n", "20"));
  const conc = Number(arg("conc", "4"));
  const modelConcurrencyRaw = arg("llm-concurrency", "");
  const modelConcurrency = modelConcurrencyRaw ? Number(modelConcurrencyRaw) : undefined;
  for (const [flag, value] of [["conc", conc], ["llm-concurrency", modelConcurrency]] as const)
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new Error(`--${flag} must be a positive safe integer`);
  const iters = Number(arg("iters", "2000"));
  // `--arms` was an exact alias for `--compare`, and the two drifted: docs kept showing an
  // arm syntax (`agentic:expand@20`) that the parser stopped accepting. One name, and a
  // pointer for anyone with the old one in their shell history.
  if (argv.includes("--arms"))
    throw new Error(
      `--arms was removed; use --compare. The arm syntax also changed: an arm now names ` +
        `branches joined with "+", e.g. --compare "none,frozen,frozen+expand,frozen+backsearch".`,
    );
  const compareSpecRequested = arg("compare", DEFAULT_COMPARE);
  // Validate every argument before touching the answer key or the corpus. A misuse should
  // fail on the misuse, not on whatever environment variable happens to be missing first.
  const backsearchCorpus = arg("backsearch-corpus", "cc_news");
  const backsearchCorpusNames = backsearchCorpora(backsearchCorpus);
  // Share the search/fetch tool-call budget across arms; accept the legacy CLI spelling.
  const maxToolCallsArg = arg("max-tool-calls", "");
  const legacyMaxSearchesArg = arg("max-searches", "");
  if (
    maxToolCallsArg &&
    legacyMaxSearchesArg &&
    maxToolCallsArg !== legacyMaxSearchesArg
  ) {
    throw new Error(
      `--max-tool-calls (${maxToolCallsArg}) and legacy --max-searches ` +
        `(${legacyMaxSearchesArg}) disagree`,
    );
  }
  if (!maxToolCallsArg && legacyMaxSearchesArg) {
    console.warn(
      `    ⚠️  --max-searches limits search and fetch tool calls together; use --max-tool-calls instead`,
    );
  }
  const maxToolCalls = Number(
    maxToolCallsArg || legacyMaxSearchesArg || String(DEFAULT_MAX_TOOL_CALLS),
  );
  const maxResultsPerSearch = Number(arg("max-results-per-search", "20"));
  const webSearchFailureLimit = Number(arg("web-search-failure-limit", "3"));
  const webZeroServedLimit = Number(arg("web-zero-served-limit", "5"));
  // v5 defaults to content, the older v3/v4 to strict. content hands pages with "no date found"
  // and "date after the anchor" to the content reviewer; the reasons and measurements are in
  // the DateGateMode comment in src/retrieval/search-backend.ts.
  // It must enter the condition identity: the two modes behave differently under the same
  // code, so their cells cannot reuse each other.
  const qualityProfile = legacyRetrievalProfile(
    argv,
    join(RESULTS_DIR, "retrieval-evidence"),
  );
  const quality = qualityProfile.enabled;
  const leakAvailabilityPolicy = arg(
    "leak-availability-policy",
    "component-availability-v5",
  );
  if (
    leakAvailabilityPolicy !== "issued-information-v3" &&
    leakAvailabilityPolicy !== "component-availability-v4" &&
    leakAvailabilityPolicy !== "component-availability-v5"
  )
    throw new Error(
      "--leak-availability-policy must be issued-information-v3, component-availability-v4 or component-availability-v5",
    );
  // v5 reviews substantive availability, including ancillary claims. Let that
  // review retain clean old content behind a later page date.
  const dateGateArg = arg(
    "date-gate",
    leakAvailabilityPolicy === "component-availability-v5"
      ? "content"
      : "strict",
  );
  if (!["strict", "content"].includes(dateGateArg))
    throw new Error(
      `--date-gate accepts only strict or content, got ${dateGateArg}`,
    );
  const dateGate = dateGateArg as DateGateMode;
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 0)
    throw new Error(`--max-tool-calls must be a non-negative integer`);
  if (!Number.isInteger(maxResultsPerSearch) || maxResultsPerSearch < 1)
    throw new Error(`--max-results-per-search must be a positive integer`);
  if (!Number.isInteger(webSearchFailureLimit) || webSearchFailureLimit < 1)
    throw new Error(`--web-search-failure-limit must be a positive integer`);
  if (!Number.isInteger(webZeroServedLimit) || webZeroServedLimit < 1)
    throw new Error(`--web-zero-served-limit must be a positive integer`);
  const llm = arg("llm", "deepseek");
  const effort = arg("effort", "");
  // vNext: the model classifies evidence and names a base rate, and we compute the probability
  // from them. Applies to every arm of the run at once — mixing ledger and non-ledger arms in
  // one run would confound the output contract with the evidence source.
  const ledger = arg("ledger", "0") === "1";
  // A fetch character limit of zero returns the whole article.
  const fetchChars = Number(arg("fetch-chars", "0"));
  const toolDelivery = parseToolDelivery(arg("tool-delivery", "paged"));
  const frozenSearchDelivery = parseFrozenSearchDelivery(
    arg(
      "frozen-search-delivery",
      frozenSearchDeliveryDefault(toolDelivery, quality),
    ),
  );
  if (frozenSearchDelivery === "lead" && (toolDelivery !== "paged" || !quality))
    throw new Error(
      "--frozen-search-delivery lead requires quality-v1 and --tool-delivery paged",
    );
  if (toolDelivery === "paged" && fetchChars !== 0)
    throw new Error(
      "--tool-delivery paged requires --fetch-chars 0; use inline for a legacy prefix condition",
    );

  // Provider input ceiling for the forecasting model, in tokens; 0 means no cap and is the
  // default every existing condition runs under. Set it only for models whose window the
  // frozen arm actually overruns — qwen3.6-35b-a3b refuses above 229,376, kimi k3 and
  // deepseek above 1,048,576 — because switching it on changes what the model reads and so
  // starts a new prediction segment. See src/predictors/context-cap.ts.
  const maxInputTokens = Number(arg("max-input-tokens", "0"));
  if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 0)
    throw new Error(
      `--max-input-tokens must be a non-negative safe integer, got ${maxInputTokens}`,
    );

  return {
    evidenceFile: arg("evidence-file", ""),
    questionsFile: arg("questions-file", ""),
    gradingFile: arg("grading-file", ""),
    includeChinaFilteredArg: arg("include-china-filtered", "0"),
    idSelection: selectedQuestionIds(
      process.argv.includes("--ids") ? arg("ids", "") : undefined,
      process.argv.includes("--ids-file") ? arg("ids-file", "") : undefined,
    ),
    backsearchMode: arg("backsearch-mode", "hybrid"),
    backsearchCorpus,
    backsearchCorpusNames,
    readerEnabled: arg("reader", "1") === "1",
    browserFallback: arg("browser-fallback", "0") === "1",
    searchProviderRequested: arg("search-provider", "auto"),
    frozenArchiveFile: arg("frozen-archive-file", ""),
    frozenCorpusFile: arg("frozen-corpus-file", "").trim(),
    expandVariants: Number(arg("expand-variants", "3")),
    leakArg: arg("leak-llm", "deepseek:deepseek-flash"),
    leakFallbackArg: arg("leak-fallback-llm", ""),
    leakFilterArg: arg("leak-filter", "1"),
    reviewThinkingRequested: arg("review-thinking", "") || undefined,
    reviewEffortRequested: arg("review-effort", "") || undefined,
    shadowReviewEffortRequested: arg("shadow-review-effort", "") || undefined,
    compareExplicit: arg("compare", ""),
    tag: arg("tag", ""),
    conditionPreviewFile: arg("condition-preview-file", "").trim(),
    registryEnabled: arg("registry", "1") !== "0",
    registryPath: arg("registry-path", "") || undefined,
    replicate: arg("replicate", "0") === "1",
    replicateReason: arg("replicate-reason", "").trim(),
    n,
    conc,
    modelConcurrency,
    iters,
    compareSpecRequested,
    maxToolCalls,
    maxResultsPerSearch,
    webSearchFailureLimit,
    webZeroServedLimit,
    qualityProfile,
    quality,
    leakAvailabilityPolicy,
    dateGate,
    llm,
    effort,
    ledger,
    fetchChars,
    toolDelivery,
    frozenSearchDelivery,
    maxInputTokens,
  } as const;
}

export function legacyFormalArguments(raw: string[], root: string): { args: string[]; profile: string; selected: Record<string, string> } {
  raw = legacyExpandConcurrencyArguments(raw);
  const values = new Map<string, string>();
  const allowed = new Set(("profile llm compare conc llm-concurrency effort n tag ids ids-file iters max-tool-calls max-searches " +
    "max-results-per-search fetch-chars max-input-tokens tool-delivery frozen-search-delivery date-gate search-provider leak-filter leak-llm leak-fallback-llm reader browser-fallback " +
    "questions-file grading-file include-china-filtered ledger evidence-file expand-variants backsearch-mode " +
    "backsearch-corpus web-search-failure-limit web-zero-served-limit replicate replicate-reason registry registry-path " +
    "condition-preview-file frozen-archive-file frozen-corpus-file arms retrieval-profile retrieval-evidence-dir retrieval-aliases-file candidate-concurrency review-concurrency cleaning-concurrency search-concurrency fetch-concurrency reader-concurrency reader-rpm page-dispatch-concurrency retrieval-scheduling wiki-cache wiki-manifest wiki-index query-expansion-model content-processing source-manifest " +
    "frozen-workers frozen-queue frozen-global-slots shared-frozen-cache shared-review-cache shared-page-cache fixed-document-manifest search-delivery review-thinking review-effort shadow-review-effort").split(" "));
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--") continue;
    const m = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(raw[i]!);
    if (!m) throw new Error("Expected named experiment arguments");
    const key = m[1]!;
    if (!allowed.has(key)) throw new Error(`Unknown experiment argument --${key}`);
    if (values.has(key)) throw new Error(`Duplicate argument --${key}`);
    const value = m[2] ?? raw[++i];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    values.set(key, value);
  }
  const profile = values.get("profile") ?? "formal-232"; values.delete("profile");
  if (!["formal-232", "custom"].includes(profile)) throw new Error("--profile must be formal-232 or custom");
  for (const key of ["registry", "registry-path", "condition-preview-file"])
    if (values.has(key)) throw new Error(`--${key} cannot bypass shared experiment admission`);
  if (!/^[a-z0-9-]+:[^\s:]+$/i.test(values.get("llm") ?? ""))
    throw new Error("Explicit --llm provider:exact-model is required");
  if (!values.has("compare")) throw new Error("Explicit --compare is required");
  const arms = values.get("compare")!.split(",").map(arm => arm.trim() === "mixed" ? "both" : arm.trim());
  arms.forEach(assertSupportedArmComposition);
  if (new Set(arms).size !== arms.length) throw new Error("Duplicate experiment arms (mixed is an alias for both)");
  values.set("compare", arms.join(","));
  if (values.get("llm")?.startsWith("jev:")) {
    if(values.get("llm")!==`jev:${JEV_MODEL}` || values.get("compare")!=="none" || values.has("effort") || values.get("ledger")==="1" || values.has("evidence-file"))
      throw new Error("Jev requires pinned jev:jev-1.13.0, none, no effort, and the reviewed prompt without added evidence");
  }
  const nativeSol=/^codex(?:-personal)?:gpt-5\.6-sol$/.test(values.get("llm")??"") || values.get("llm")==="codex:gpt-6-sol";
  if (values.get("llm") === "codex:gpt-6-astra" || nativeSol) {
    if(nativeSol && values.get("effort")!=="high") throw new Error("Sol requires explicit high effort");
    if (!/^(none|frozen|web-filter|both)(,(none|frozen|web-filter|both))*$/.test(values.get("compare")!))
      throw new Error("Native Codex subscription supports only none, frozen, web-filter and both");
    if (values.has("effort") && !["low", "medium", "high", "xhigh", "max"].includes(values.get("effort")!))
      throw new Error("Unsupported Astra effort; omit for the provider default");
    if (values.get("ledger") === "1" || values.has("evidence-file"))
      throw new Error("Native Codex subscription requires the reviewed structured forecast without added evidence");
  } else if (/^codex(?:-personal)?:/.test(values.get("llm")??""))
    throw new Error("Unsupported native Codex model/account");
  if (/^claude:/.test(values.get("llm")??"")) {
    if (!new Set(["claude:claude-opus-5","claude:claude-opus-5-5"]).has(values.get("llm")??"") ||
        !/^(none|frozen|web-filter|both)(,(none|frozen|web-filter|both))*$/.test(values.get("compare")!))
      throw new Error("Claude subscription admits only pinned Opus models with none, frozen, web-filter or both");
    if (values.get("ledger")==="1" || values.has("evidence-file"))
      throw new Error("Claude requires the reviewed forecast without added evidence");
  }
  if ((values.get("llm")==="codex:gpt-6-astra" || nativeSol || /^claude:/.test(values.get("llm")??"")) && armUsesWebFilter(values.get("compare"))) {
    if (!values.has("leak-llm") || values.get("leak-filter")==="0")
      throw new Error("Subscription web-filter requires an explicit --leak-llm and enabled review");
  }
  if (!/^\d+$/.test(values.get("conc") ?? "") || Number(values.get("conc")) < 1)
    throw new Error("Explicit positive --conc is required");
  if (values.has("llm-concurrency") && (!Number.isSafeInteger(Number(values.get("llm-concurrency"))) || Number(values.get("llm-concurrency")) < 1))
    throw new Error("--llm-concurrency must be a positive safe integer");
  if (values.has("max-input-tokens") &&
      (!/^\d+$/.test(values.get("max-input-tokens")!) || !Number.isSafeInteger(Number(values.get("max-input-tokens")))))
    throw new Error("--max-input-tokens must be a non-negative safe integer");
  if (values.has("replicate") && !["0", "1"].includes(values.get("replicate")!))
    throw new Error("--replicate must be 0 or 1; identify a repeated experiment with --tag and --replicate-reason");
  if (values.get("replicate") === "1" && !values.get("replicate-reason")?.trim())
    throw new Error("--replicate 1 requires a nonempty --replicate-reason");
  if (values.get("replicate-reason")?.trim() && values.get("replicate") !== "1")
    throw new Error("--replicate-reason requires --replicate 1; otherwise successful cells would be reused");
  const selectedIds = selectedQuestionIds(values.get("ids"), values.get("ids-file"));
  if (profile === "formal-232") {
    if (!/^(none|frozen|web-filter|both)(,(none|frozen|web-filter|both))*$/.test(values.get("compare")!))
      throw new Error("Formal profile allows none, frozen, web-filter and both without expansion");
    const fixed = {
      n: "232", "include-china-filtered": "1", ledger: "0", "max-tool-calls": String(DEFAULT_MAX_TOOL_CALLS),
      "max-results-per-search": "20", "fetch-chars": "0", "leak-filter": "1", reader: "1",
    };
    for (const [key, value] of Object.entries(fixed)) {
      if (values.has(key) && values.get(key) !== value) throw new Error(`Formal profile requires --${key} ${value}`);
      values.set(key, value);
    }
    if ((values.get("retrieval-profile") ?? "quality-v1") === "baseline") {
      for (const [key,value] of Object.entries({"date-gate":"strict","search-provider":"serper"})) {
        if (values.has(key) && values.get(key) !== value) throw new Error(`Legacy formal profile requires --${key} ${value}`);
        values.set(key,value);
      }
    }
    for (const key of ["max-searches", "evidence-file", "expand-variants", "frozen-archive-file", "arms"])
      if (values.has(key)) throw new Error(`--${key} is not part of the formal profile`);
    for (const [key, name] of [["questions-file", "raven_model_test.jsonl"], ["grading-file", "raven_grading_key.jsonl"]]) {
      const path = join(root, "question-making/curated", name!);
      if (values.has(key!) && realpathSync(values.get(key!)!) !== realpathSync(path))
        throw new Error(`--${key} uses this checkout's formal profile files; use --profile custom for other paths`);
      values.set(key!, path);
    }
    if (armUsesWebFilter(values.get("compare")) && !values.has("leak-llm"))
      throw new Error("web-filter requires an explicit --leak-llm provider:exact-model");
    if (selectedIds) {
      const valid = new Set(readFileSync(join(root,"question-making/curated/raven_model_test.jsonl"),"utf8")
        .trim().split("\n").map(s => normalizeQuestionId(JSON.parse(s).id)));
      for (const id of selectedIds)
        if (!valid.has(normalizeQuestionId(id)))
          throw new Error(`Subset contains an ID outside the formal 232 questions: ${id}`);
    }
  } else if (!values.get("questions-file") || !values.get("grading-file")) {
    throw new Error("Custom profile requires explicit question and grading files; no implicit legacy dataset");
  }
  const delivery = parseToolDelivery(values.get('tool-delivery') ?? 'paged');
  values.set('tool-delivery', delivery);
  if (delivery === 'paged' && Number(values.get('fetch-chars') ?? '0') !== 0)
    throw new Error('--tool-delivery paged requires --fetch-chars 0');
  values.set("retrieval-profile", values.get("retrieval-profile") ?? "quality-v1");
  if(armUsesFrozen(values.get('compare')) && values.get('retrieval-profile')==='quality-v1') {
    if(!values.has('shared-frozen-cache')) values.set('shared-frozen-cache',FROZEN_SHARED_CACHE);
    if(!values.has('frozen-global-slots')) values.set('frozen-global-slots',String(frozenCacheSlots(FROZEN_SHARED_CACHE)));
  } else if(values.has('shared-frozen-cache')||values.has('frozen-global-slots')) throw new Error('--shared-frozen-cache requires quality-v1 frozen retrieval');
  if (values.get('compare')!.split(',').includes('both') &&
      (values.get('retrieval-profile') !== 'quality-v1' || !values.has('leak-llm') || values.has('frozen-archive-file')))
    throw new Error('both requires quality-v1, explicit --leak-llm and no archive supplement');
  const frozenDelivery = parseFrozenSearchDelivery(values.get('frozen-search-delivery') ??
    frozenSearchDeliveryDefault(delivery, values.get('retrieval-profile') === 'quality-v1'));
  if (frozenDelivery === 'lead' && (delivery !== 'paged' || values.get('retrieval-profile') !== 'quality-v1'))
    throw new Error('--frozen-search-delivery lead requires quality-v1 and --tool-delivery paged');
  values.set('frozen-search-delivery', frozenDelivery);
  values.set("search-provider", values.get("search-provider") ?? "serper");
  if (!["serper","brave","auto"].includes(values.get("search-provider")!))
    throw new Error("--search-provider must be serper, brave or auto");
  // Record the team's chosen reviewer default in the admitted arguments, so it
  // reaches the trace and condition identity. Explicit comparison arms keep
  // their requested settings, including non-thinking and paired reviews.
  if (!values.has("review-effort") && !values.has("shadow-review-effort") &&
      armUsesWebFilter(values.get("compare")) &&
      values.get("retrieval-profile") === "quality-v1" &&
      (values.get("leak-llm") ?? "deepseek:deepseek-flash") === "deepseek:deepseek-flash" &&
      !values.get("leak-fallback-llm") && values.get("leak-filter") !== "0" &&
      values.get("review-thinking") !== "disabled") {
    values.set("review-effort", "low");
  }
  validateReviewerThinking(values.get("review-thinking"), {
    compare: values.get("compare")!, profile: values.get("retrieval-profile")!,
    model: values.get("leak-llm") ?? "deepseek:deepseek-flash",
    fallback: values.get("leak-fallback-llm"), filter: values.get("leak-filter"),
  });
  validateReviewerEffort(values.get("review-effort"), {
    compare: values.get("compare")!, profile: values.get("retrieval-profile")!,
    model: values.get("leak-llm") ?? "deepseek:deepseek-flash",
    fallback: values.get("leak-fallback-llm"), filter: values.get("leak-filter"), thinking: values.get("review-thinking"),
  });
  validateShadowReviewEffort(values.get("shadow-review-effort"), {
    compare: values.get("compare")!, profile: values.get("retrieval-profile")!,
    model: values.get("leak-llm") ?? "deepseek:deepseek-flash",
    fallback: values.get("leak-fallback-llm"), filter: values.get("leak-filter"), thinking: values.get("review-thinking"),
    primaryEffort: values.get("review-effort"), processing: values.get("content-processing") ?? 'single-pass',
  });
  const args = [...values].flatMap(([k,v]) => [`--${k}`,v]);
  legacyRetrievalProfile(args, join(SHARED_RESULTS_DIR,"retrieval-evidence")); // Reject incompatible switches during admission.
  return { args, profile, selected: Object.fromEntries(values) };
}
