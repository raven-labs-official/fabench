/**
 * The one list of forecasting-run parameters. Every entry path (the shared launcher's
 * admission, the direct runner, condition previews, the continuation controller's checks and
 * `pnpm exp:params`) reads this list; nothing else declares a run parameter or its default.
 *
 * Secrets (API keys, webhook URLs, login sessions) are not parameters: they stay in the team
 * env files and are never listed, resolved or printed here.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultFrozenWorkers } from "../../../vendor/retrieval-infra/src/corpus/frozen-execution.js";
import { frozenCacheSlots } from "../../../vendor/retrieval-infra/src/corpus/frozen-route-cache.js";
import { FROZEN_SHARED_CACHE, TEAM_CONFIG_DIR } from "../../path-config.js";
import { DEFAULT_MAX_TOOL_CALLS } from "../../predictors/tool-budget.js";
import { frozenSearchDeliveryDefault } from "../../predictors/frozen-search-preview.js";

export const CATEGORIES = {
  design: "Experiment design: changes what the model sees or how its answer is read",
  efficiency: "Efficiency and concurrency",
  services: "External services and rate limits",
  paths: "Paths and environment",
  run: "Run management",
} as const;
export type Category = keyof typeof CATEGORIES;

export type Value = string | number | boolean | null;

export type ParameterType =
  | { kind: "string" }
  | { kind: "integer"; min?: number; max?: number }
  | { kind: "number"; positive?: boolean; nonNegative?: boolean }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "path" }
  | { kind: "url" }
  | { kind: "model" }
  | { kind: "date" }
  | { kind: "time-zone" }
  /** Read only by a Python helper with float(); any text float() accepts, kept as written. */
  | { kind: "python-float" }
  /** Read only by a Python helper with int(); any text int() accepts, kept as written. */
  | { kind: "python-int" };

/**
 * When a parameter is used. A default, preset or override-file value that does not apply to
 * the selected arms or retrieval profile is recorded but not passed on, so one preset or
 * override file serves every arm. A command-line value is always passed on, so the runner
 * rejects a misplaced flag exactly where it did before.
 */
export type Condition =
  | "quality"
  | "baseline"
  | "frozen"
  | "web-filter"
  | "expand"
  | "backsearch";

/** What a derived default may look at: other resolved values and the host. */
export interface DeriveContext {
  value(key: string): Value;
  uses(condition: Condition): boolean;
  /** True when the shared frozen-query cache directory exists on this host (the shared server). */
  sharedFrozenCacheAvailable: boolean;
  resultsDir: string;
}

export interface ParameterSpec {
  key: string;
  category: Category;
  /** CLI spelling without `--`; always the key with `_` replaced by `-`. */
  flag?: string;
  /** Environment variable; for a flag parameter it overrides only the built-in default. */
  env?: string;
  /** Environment lookup also reads the team env file (provider endpoints read that way). */
  envFile?: boolean;
  type: ParameterType;
  default: Value;
  /** Computed default when no layer sets the key; `text` documents it. */
  derived?: { text: string; compute(context: DeriveContext): Value };
  /** Human description of a default the vendor applies when the value is unset. */
  defaultText?: string;
  /** Changes what the model sees or how its answer is read. */
  affectsResults: boolean;
  /** Enters condition_id (directly or through a nested configuration object). */
  inCondition: boolean;
  when?: readonly Condition[];
  /**
   * For an environment variable: when this run actually reads it. A malformed value is an
   * error only then; otherwise it is reported and ignored. Without this field the variable
   * follows `when`, or is always read.
   */
  usedBy?: { conditions?: readonly Condition[]; providers?: readonly string[] };
  /** A default value is not passed on (the runner's own default is the same). */
  emitDefault?: false;
  /** Bench default written into the environment when unset (the vendor's default differs). */
  exportDefault?: boolean;
  /** Handled by the resolver itself (preset and override-file selection). */
  meta?: boolean;
  repeatable?: boolean;
  meaning: string;
}

const integer = (min?: number, max?: number): ParameterType => ({ kind: "integer", min, max });
const enumeration = (...values: string[]): ParameterType => ({ kind: "enum", values });
const PATH: ParameterType = { kind: "path" };
const STRING: ParameterType = { kind: "string" };
const BOOLEAN: ParameterType = { kind: "boolean" };
const MODEL: ParameterType = { kind: "model" };
const URL_TYPE: ParameterType = { kind: "url" };
const POSITIVE_NUMBER: ParameterType = { kind: "number", positive: true };
const PYTHON_FLOAT: ParameterType = { kind: "python-float" };
/** Variables every run reads: the page dater is built even for closed-book arms. */
const ALWAYS = { conditions: [] } as const;
const WEB = { conditions: ["web-filter"] } as const;
const BASELINE_WEB = { conditions: ["baseline", "web-filter"] } as const;
const BACKSEARCH = { conditions: ["backsearch"] } as const;
const provider = (...providers: string[]) => ({ providers });

type Entry = Omit<ParameterSpec, "flag" | "category"> & { flag?: boolean | string };

/** `flag: true` derives the spelling from the key; env-only parameters omit it. */
function section(category: Category, entries: Entry[]): ParameterSpec[] {
  return entries.map(({ flag, ...entry }) => ({
    ...entry,
    category,
    ...(flag ? { flag: typeof flag === "string" ? flag : entry.key.replaceAll("_", "-") } : {}),
  }));
}

export const RUN_PARAMETERS: readonly ParameterSpec[] = [
  ...section("design", [
    { key: "llm", flag: true, type: MODEL, default: "deepseek", affectsResults: true, inCondition: true,
      meaning: "Forecasting model as provider:model; a bare provider uses its default model" },
    { key: "effort", flag: true, type: STRING, default: null, affectsResults: true, inCondition: true,
      defaultText: "provider default", meaning: "Reasoning effort of the forecasting model" },
    { key: "compare", flag: "settings", type: STRING, default: "none,frozen,both", affectsResults: true, inCondition: true,
      meaning: "Comma-separated settings (arms): none, frozen, web-filter, both, backsearch, provided; join with + to merge, add +expand" },
    { key: "n", flag: true, type: integer(0), default: 20, affectsResults: false, inCondition: false,
      meaning: "Number of questions in the stratified sample; 0 or at least the bank size takes all; ignored when --ids is given" },
    { key: "ids", flag: true, type: STRING, default: null, affectsResults: false, inCondition: false,
      meaning: "Run only these question ids (comma or space separated); takes precedence over --n" },
    { key: "ids_file", flag: true, type: PATH, default: null, affectsResults: false, inCondition: false,
      meaning: "File of question ids; lines starting with # are comments; use instead of --ids" },
    { key: "questions_file", flag: true, type: PATH, default: null, affectsResults: true, inCondition: true,
      defaultText: "old beta-raven selected_300", meaning: "Question bank JSONL; its content hash enters question_set_id" },
    { key: "grading_file", flag: true, type: PATH, default: null, affectsResults: true, inCondition: true,
      meaning: "Answer file; requires --questions-file" },
    { key: "include_china_filtered", flag: true, type: BOOLEAN, default: false, affectsResults: false, inCondition: false,
      meaning: "Keep China-related political questions that may trigger the content_filter of Chinese models" },
    { key: "ledger", flag: true, type: BOOLEAN, default: false, affectsResults: true, inCondition: true,
      meaning: "Evidence-ledger output: the model classifies evidence and gives a base rate; code computes the probability" },
    { key: "evidence_file", flag: true, type: PATH, default: null, affectsResults: true, inCondition: true,
      meaning: "Fixed evidence packet JSON for the provided arm" },
    { key: "max_tool_calls", flag: true, type: integer(0), default: DEFAULT_MAX_TOOL_CALLS, affectsResults: true, inCondition: true,
      meaning: "Per-question limit on search and fetch tool calls combined" },
    { key: "max_results_per_search", flag: true, type: integer(1), default: 20, affectsResults: true, inCondition: true,
      meaning: "Maximum results returned per search" },
    { key: "fetch_chars", flag: true, type: integer(0), default: 0, affectsResults: true, inCondition: true,
      meaning: "Characters a fetch returns under inline delivery; 0 = full text (paged and quality-v1 require 0)" },
    { key: "tool_delivery", flag: true, type: enumeration("inline", "paged"), default: "paged", affectsResults: true, inCondition: true,
      meaning: "How tool text is delivered: paged in pages, inline all at once" },
    { key: "frozen_search_delivery", flag: true, type: enumeration("lead", "fulltext"), default: null, affectsResults: true, inCondition: true,
      derived: { text: "lead with paged and quality-v1, otherwise fulltext",
        compute: (c) => frozenSearchDeliveryDefault(c.value("tool_delivery") as "inline" | "paged", c.uses("quality")) },
      meaning: "How frozen search results are shown: lead gives the beginning, fulltext the whole text" },
    { key: "max_input_tokens", flag: true, type: integer(0), default: 0, affectsResults: true, inCondition: true,
      meaning: "Input token limit of the forecasting model; 0 = no limit" },
    { key: "retrieval_profile", flag: true, type: enumeration("baseline", "quality-v1"), default: "quality-v1", affectsResults: true, inCondition: true,
      meaning: "Retrieval pipeline: quality-v1 is current, baseline is the old compatible one" },
    { key: "content_processing", flag: true, type: enumeration("single-pass", "whole-document", "integrated"), default: null,
      affectsResults: true, inCondition: true,
      derived: { text: "single-pass with quality-v1, otherwise whole-document",
        compute: (c) => (c.uses("quality") ? "single-pass" : "whole-document") },
      meaning: "How web pages are reviewed" },
    { key: "search_delivery", flag: true, type: enumeration("fulltext", "summary"), default: null, affectsResults: true, inCondition: true,
      derived: { text: "summary with quality-v1 single-pass, otherwise fulltext",
        compute: (c) => (c.uses("quality") && c.value("content_processing") === "single-pass" ? "summary" : "fulltext") },
      meaning: "Form in which web results reach the model: reviewed summary or full text" },
    { key: "leak_llm", flag: true, type: MODEL, default: "deepseek:deepseek-flash", affectsResults: true, inCondition: true,
      meaning: "Model that reviews web evidence" },
    { key: "leak_fallback_llm", flag: true, type: MODEL, default: null, affectsResults: true, inCondition: true,
      meaning: "Fallback review model when the review model cannot take a page" },
    { key: "leak_filter", flag: true, type: BOOLEAN, default: true, affectsResults: true, inCondition: true,
      meaning: "Web evidence review switch; web arms require it on" },
    { key: "review_thinking", flag: true, type: enumeration("enabled", "disabled"), default: null, when: ["web-filter"],
      affectsResults: true, inCondition: true, defaultText: "provider default (thinking on)",
      meaning: "Thinking switch of the DeepSeek Flash review model" },
    { key: "review_effort", flag: true, type: enumeration("low", "high", "max"), default: null, when: ["web-filter"],
      affectsResults: true, inCondition: true,
      derived: { text: "low for a quality-v1 web arm whose review model is deepseek:deepseek-flash, with no fallback reviewer, thinking not disabled and no shadow effort; otherwise the provider default",
        compute: (c) =>
          c.uses("web-filter") && c.uses("quality") &&
          c.value("leak_llm") === "deepseek:deepseek-flash" && !c.value("leak_fallback_llm") &&
          c.value("leak_filter") === true && c.value("review_thinking") !== "disabled" &&
          !c.value("shadow_review_effort")
            ? "low"
            : null },
      meaning: "Reasoning effort of the review model" },
    { key: "shadow_review_effort", flag: true, type: enumeration("low", "high", "max"), default: null, when: ["web-filter"],
      affectsResults: true, inCondition: true, meaning: "Second review effort for comparison (recorded only, not given to the forecasting model)" },
    { key: "search_provider", flag: true, type: enumeration("serper", "brave", "anthropic", "zhipu", "auto"), default: "serper",
      affectsResults: true, inCondition: true,
      meaning: "Web search service; auto must be given explicitly and takes the first of anthropic, serper, zhipu that has a key" },
    { key: "reader", flag: true, type: BOOLEAN, default: true, affectsResults: true, inCondition: true,
      meaning: "Read pages through Jina reader when direct fetching fails" },
    { key: "browser_fallback", flag: true, type: BOOLEAN, default: false, affectsResults: true, inCondition: true,
      meaning: "Render pages in a browser when direct fetching and reader both fail (requires quality-v1)" },
    { key: "frozen_corpus_file", flag: true, type: PATH, default: null, when: ["frozen"], affectsResults: true, inCondition: true,
      defaultText: "environment variable FABENCH_CORPUS_DB", meaning: "Historical index used by frozen retrieval" },
    { key: "frozen_archive_file", flag: true, type: PATH, default: null, when: ["frozen"], affectsResults: true, inCondition: true,
      meaning: "Capture supplement file for frozen retrieval" },
    { key: "wiki_manifest", flag: true, type: PATH, default: null, when: ["quality", "frozen"], affectsResults: true, inCondition: true,
      meaning: "Wiki manifest used by frozen retrieval; requires --wiki-cache" },
    { key: "query_expansion_model", flag: true, type: MODEL, default: null, when: ["quality", "frozen"], affectsResults: true, inCondition: true,
      meaning: "Model that writes equivalent query rewrites for frozen retrieval" },
    { key: "retrieval_aliases_file", flag: true, type: PATH, default: null, when: ["quality"], affectsResults: true, inCondition: true,
      meaning: "Query alias table for frozen retrieval (JSON array)" },
    { key: "source_manifest", flag: true, type: PATH, default: null, when: ["quality"], affectsResults: true, inCondition: true,
      meaning: "Manifest of registered sources used in review" },
    { key: "fixed_document_manifest", flag: true, type: PATH, default: null, when: ["quality"], affectsResults: true, inCondition: true,
      meaning: "Manifest of fixed document texts" },
    { key: "shared_page_cache", flag: true, type: PATH, default: null, when: ["quality"], affectsResults: true, inCondition: true,
      meaning: "Directory of fixed web page snapshots; the directory path enters the condition" },
    { key: "date_gate", flag: true, type: enumeration("strict", "content"), default: null, when: ["baseline"],
      affectsResults: true, inCondition: true,
      derived: { text: "content with component-availability-v5, otherwise strict",
        compute: (c) => (c.value("leak_availability_policy") === "component-availability-v5" ? "content" : "strict") },
      meaning: "Date gate of baseline web arms" },
    { key: "leak_availability_policy", flag: true,
      type: enumeration("issued-information-v3", "component-availability-v4", "component-availability-v5"),
      default: "component-availability-v5", when: ["baseline"], affectsResults: true, inCondition: true,
      meaning: "Availability rule of baseline review" },
    { key: "expand_variants", flag: true, type: integer(1), default: 3, when: ["expand"], affectsResults: true, inCondition: true,
      meaning: "Rewrites per query in +expand arms" },
    { key: "backsearch_mode", flag: true, type: enumeration("dense", "bm25", "hybrid", "hybrid-legacy"), default: "hybrid",
      when: ["backsearch"], affectsResults: true, inCondition: true, meaning: "BackSearch retrieval mode" },
    { key: "backsearch_corpus", flag: true, type: STRING, default: "cc_news", when: ["backsearch"], affectsResults: true, inCondition: true,
      meaning: "BackSearch corpora (comma separated; cc_sec is not allowed)" },
    { key: "leak_review_attempts", env: "LEAK_REVIEW_ATTEMPTS", type: integer(1), default: 2, usedBy: BASELINE_WEB,
      affectsResults: true, inCondition: true,
      meaning: "Attempts of baseline review" },
    { key: "leak_retry_delay_ms", env: "LEAK_RETRY_DELAY_MS", type: integer(0), default: 500, usedBy: BASELINE_WEB,
      affectsResults: false, inCondition: false,
      meaning: "Delay between baseline review attempts" },
    { key: "leak_fallback_review_attempts", env: "LEAK_FALLBACK_REVIEW_ATTEMPTS", type: integer(1), default: 2, usedBy: BASELINE_WEB,
      affectsResults: true, inCondition: true, meaning: "Attempts of the baseline fallback review" },
    { key: "leak_review_chars", env: "LEAK_REVIEW_CHARS", type: integer(1), default: 40000, usedBy: BASELINE_WEB,
      affectsResults: true, inCondition: true,
      meaning: "Characters per segment in baseline review" },
    { key: "backsearch_coverage_start", env: "BACKSEARCH_COVERAGE_START", type: { kind: "date" }, default: "2025-12-01", usedBy: BACKSEARCH,
      affectsResults: true, inCondition: true, meaning: "Start of BackSearch coverage; earlier anchors are not queried" },
  ]),
  ...section("efficiency", [
    { key: "conc", flag: true, type: integer(1), default: 4, affectsResults: false, inCondition: false,
      meaning: "Questions run at the same time" },
    { key: "llm_concurrency", flag: true, type: integer(1), default: null, affectsResults: false, inCondition: false,
      defaultText: "equal to --conc", meaning: "Concurrent requests to the forecasting model" },
    { key: "frozen_workers", flag: true, type: integer(1, 32), default: null, when: ["quality"], affectsResults: false, inCondition: true,
      derived: { text: "min(4, available CPUs)", compute: () => defaultFrozenWorkers() },
      meaning: "Frozen retrieval workers in this process" },
    { key: "frozen_queue", flag: true, type: integer(1), default: 64, when: ["quality"], affectsResults: false, inCondition: true,
      meaning: "Limit of the frozen retrieval wait queue" },
    { key: "shared_frozen_cache", flag: true, type: PATH, default: null, when: ["quality", "frozen"], affectsResults: false, inCondition: true,
      derived: { text: `${FROZEN_SHARED_CACHE} when the shared cache directory exists (shared server), otherwise none`,
        compute: (c) => (c.sharedFrozenCacheAvailable ? FROZEN_SHARED_CACHE : null) },
      meaning: "Frozen query cache shared across runs" },
    { key: "frozen_global_slots", flag: true, type: integer(1, 32), default: null, when: ["quality", "frozen"],
      affectsResults: false, inCondition: true,
      derived: { text: "Slot count recorded in the shared cache (4 when none is recorded)",
        compute: (c) => {
          const cache = c.value("shared_frozen_cache");
          return typeof cache === "string" ? frozenCacheSlots(cache) : null;
        } },
      meaning: "Global compute slots for one shared cache; must match the cache configuration" },
    { key: "candidate_concurrency", flag: true, type: integer(1), default: null, when: ["quality"], affectsResults: false, inCondition: true,
      defaultText: "8", meaning: "Web candidates processed in parallel" },
    { key: "retrieval_scheduling", flag: true, type: enumeration("rolling", "batches"), default: null, when: ["quality"],
      affectsResults: false, inCondition: true, defaultText: "rolling", meaning: "Scheduling of web candidates" },
    { key: "review_concurrency", flag: true, type: integer(1), default: null, when: ["quality"], affectsResults: false, inCondition: true,
      defaultText: "16", meaning: "Concurrent review requests" },
    { key: "cleaning_concurrency", flag: true, type: integer(1), default: null, when: ["quality"], affectsResults: false, inCondition: true,
      defaultText: "4", meaning: "Concurrent whole-document cleaning" },
    { key: "search_concurrency", flag: true, env: "SEARCH_CONCURRENCY", type: integer(1), default: null, when: ["quality"], usedBy: WEB,
      affectsResults: false, inCondition: true, defaultText: "16", meaning: "Search HTTP concurrency of this process (fixed per process)" },
    { key: "fetch_concurrency", flag: true, env: "FETCH_CONCURRENCY", type: integer(1), default: null, when: ["quality"], usedBy: ALWAYS,
      affectsResults: false, inCondition: true, defaultText: "48", meaning: "Concurrent direct page fetches" },
    { key: "page_dispatch_concurrency", flag: true, env: "PAGE_DATER_DISPATCH_CONCURRENCY", type: integer(1), default: null,
      when: ["quality"], usedBy: ALWAYS, affectsResults: false, inCondition: true, defaultText: "64", meaning: "Dispatch concurrency of the page-fetch helper" },
    { key: "shared_review_cache", flag: true, type: PATH, default: null, when: ["quality", "web-filter"], affectsResults: false, inCondition: false,
      defaultText: "review-cache under this run's evidence directory", meaning: "Directory of review receipts reused across runs" },
    { key: "wiki_index", flag: true, type: PATH, default: null, when: ["quality", "frozen"], affectsResults: false, inCondition: true,
      meaning: "Prebuilt on-disk Wiki index (for large manifests)" },
    { key: "leak_concurrency", env: "LEAK_CONCURRENCY", type: integer(1), default: 12, usedBy: BASELINE_WEB,
      affectsResults: false, inCondition: true,
      meaning: "Concurrency of baseline review" },
    { key: "bm25_extension", env: "FABENCH_BM25_EXTENSION", type: STRING, default: null, affectsResults: false, inCondition: false,
      defaultText: "native/build/raven_bm25.so when built; an empty string turns it off", meaning: "Native BM25 extension (same ranking)" },
    { key: "page_dater_cpu_stage_limit_s", env: "PAGE_DATER_CPU_STAGE_LIMIT_S", type: PYTHON_FLOAT, default: "600", usedBy: WEB,
      affectsResults: false, inCondition: false, meaning: "CPU stage time limit of the fetch helper (seconds, Python float; inf = no limit, 0 or negative = off)" },
    { key: "bounded_http_idle_s", env: "BOUNDED_HTTP_IDLE_S", type: PYTHON_FLOAT, default: "60", usedBy: WEB,
      affectsResults: false, inCondition: false, meaning: "Idle time before the fetch helper retires an HTTP worker process (seconds, Python float)" },
    { key: "bounded_http_max_workers", env: "BOUNDED_HTTP_MAX_WORKERS", type: { kind: "python-int" }, default: null, usedBy: WEB,
      affectsResults: false, inCondition: false, defaultText: "max(128, FETCH_CONCURRENCY+16); 0 or negative counts as 1",
      meaning: "Limit on HTTP worker processes of the fetch helper (Python int)" },
    { key: "cpu_profile_dir", env: "FABENCH_CPU_PROFILE_DIR", type: PATH, default: null, affectsResults: false, inCondition: false,
      meaning: "Output directory for main-thread CPU sampling; unset = no sampling" },
    { key: "resource_metrics_file", env: "FABENCH_RESOURCE_METRICS_FILE", type: PATH, default: null, affectsResults: false, inCondition: false,
      meaning: "Resource metrics output file" },
  ]),
  ...section("services", [
    { key: "reader_concurrency", flag: true, env: "JINA_CONCURRENCY", type: integer(1), default: null, when: ["quality"], usedBy: ALWAYS,
      affectsResults: false, inCondition: true, defaultText: "16", meaning: "Jina reader concurrency" },
    { key: "reader_rpm", flag: true, env: "JINA_RPM", type: integer(1), default: null, when: ["quality"], usedBy: ALWAYS,
      affectsResults: false, inCondition: true, defaultText: "400", meaning: "Jina reader requests per minute" },
    { key: "web_search_failure_limit", flag: true, type: integer(1), default: 3, when: ["baseline"], affectsResults: false, inCondition: true,
      meaning: "Consecutive search failures that trip the breaker of a baseline web arm" },
    { key: "web_zero_served_limit", flag: true, type: integer(1), default: 5, when: ["baseline"], affectsResults: false, inCondition: true,
      meaning: "Consecutive zero-result searches that warn in a baseline web arm" },
    { key: "reader_timeout_s", env: "READER_TIMEOUT_S", type: POSITIVE_NUMBER, default: 30, affectsResults: false, inCondition: true,
      meaning: "Reader request timeout (seconds)" },
    { key: "page_dater_preflight_grace_ms", env: "PAGE_DATER_PREFLIGHT_GRACE_MS", type: POSITIVE_NUMBER, default: 5000,
      affectsResults: false, inCondition: true, meaning: "Extra wait for the fetch helper preflight (milliseconds)" },
    { key: "direct_timeout_s", env: "DIRECT_TIMEOUT_S", type: PYTHON_FLOAT, default: "8", usedBy: WEB, affectsResults: false,
      inCondition: false, meaning: "Direct page fetch timeout (seconds, Python float)" },
    { key: "search_timeout_ms", env: "SEARCH_TIMEOUT_MS", type: POSITIVE_NUMBER, default: 45000, usedBy: WEB, affectsResults: false,
      inCondition: false, meaning: "Search request timeout (milliseconds)" },
    { key: "backsearch_base", env: "BACKSEARCH_BASE", type: URL_TYPE, default: "https://search.openreward.ai", usedBy: BACKSEARCH,
      affectsResults: false, inCondition: false, meaning: "BackSearch service address" },
    { key: "backsearch_timeout_ms", env: "BACKSEARCH_TIMEOUT_MS", type: POSITIVE_NUMBER, default: 45000, usedBy: BACKSEARCH,
      affectsResults: false, inCondition: false, meaning: "BackSearch request timeout (milliseconds)" },
    { key: "peak_multiplier", env: "FABENCH_PEAK_MULTIPLIER", type: { kind: "number", nonNegative: true }, default: null,
      affectsResults: false, inCondition: false,
      defaultText: "1 or 2 by the provider's peak hours", meaning: "Peak multiplier for cost estimates" },
    { key: "deepseek_base_url", usedBy: provider("deepseek"), env: "DEEPSEEK_BASE_URL", envFile: true, type: URL_TYPE, default: "https://api.deepseek.com/v1",
      affectsResults: false, inCondition: true, meaning: "DeepSeek endpoint" },
    { key: "glm_base_url", usedBy: provider("glm"), env: "GLM_BASE_URL", envFile: true, type: URL_TYPE, default: "https://open.bigmodel.cn/api/coding/paas/v4",
      exportDefault: true, affectsResults: false, inCondition: true, meaning: "GLM endpoint (team default: the coding endpoint)" },
    { key: "kimi_base_url", usedBy: provider("kimi"), env: "KIMI_BASE_URL", envFile: true, type: URL_TYPE, default: "https://api.kimi.com/coding/v1",
      affectsResults: false, inCondition: true, meaning: "Kimi endpoint" },
    { key: "bailian_base_url", usedBy: provider("bailian"), env: "BAILIAN_BASE_URL", envFile: true, type: URL_TYPE,
      default: "https://dashscope.aliyuncs.com/compatible-mode/v1", affectsResults: false, inCondition: true,
      meaning: "Bailian pay-as-you-go endpoint" },
    { key: "bailian_coding_plan_base_url", usedBy: provider("bailian"), env: "BAILIAN_CODING_PLAN_BASE_URL", envFile: true, type: URL_TYPE,
      default: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", affectsResults: false, inCondition: true,
      meaning: "Bailian Token Plan endpoint (official endpoints only)" },
    { key: "openrouter_base_url", usedBy: provider("openrouter"), env: "OPENROUTER_BASE_URL", envFile: true, type: URL_TYPE, default: "https://openrouter.ai/api/v1",
      affectsResults: false, inCondition: true, meaning: "OpenRouter endpoint" },
    { key: "custom_base_url", usedBy: provider("custom"), env: "CUSTOM_BASE_URL", envFile: true, type: URL_TYPE, default: null, affectsResults: false,
      inCondition: true, meaning: "custom provider endpoint" },
    { key: "custom_price_in", usedBy: provider("custom"), env: "CUSTOM_PRICE_IN", envFile: true, type: { kind: "number", nonNegative: true }, default: 0,
      affectsResults: false, inCondition: false, meaning: "custom provider input price (per million tokens)" },
    { key: "custom_price_out", usedBy: provider("custom"), env: "CUSTOM_PRICE_OUT", envFile: true, type: { kind: "number", nonNegative: true }, default: 0,
      affectsResults: false, inCondition: false, meaning: "custom provider output price (per million tokens)" },
    { key: "anthropic_search_model", env: "ANTHROPIC_SEARCH_MODEL", envFile: true, type: STRING, default: "claude-haiku-4-5",
      affectsResults: true, inCondition: false, meaning: "Model used by --search-provider anthropic" },
    { key: "zhipu_search_engine", env: "ZHIPU_SEARCH_ENGINE", envFile: true, type: STRING, default: "search_std",
      affectsResults: true, inCondition: false, meaning: "Engine used by --search-provider zhipu" },
    { key: "api_admission_db", env: "FABENCH_API_ADMISSION_DB", type: PATH, default: null, affectsResults: false, inCondition: true,
      defaultText: "unset = no cross-user rate limiting (the shared launcher always sets it)", meaning: "Cross-user API rate-limit database" },
  ]),
  ...section("paths", [
    { key: "wiki_cache", flag: true, type: PATH, default: null, when: ["quality"], affectsResults: false, inCondition: false,
      meaning: "Cache of historical Wiki revisions" },
    { key: "retrieval_evidence_dir", flag: true, type: PATH, default: null, when: ["quality"], affectsResults: false, inCondition: false,
      derived: { text: "retrieval-evidence under the results directory", compute: (c) => join(c.resultsDir, "retrieval-evidence") },
      meaning: "Directory of retrieval evidence and review cache" },
    { key: "registry_path", flag: true, env: "FABENCH_EXPERIMENT_REGISTRY", type: PATH, default: null, affectsResults: false,
      inCondition: false, defaultText: "the shared registry on the shared server, otherwise results/experiment-registry.sqlite", meaning: "Experiment registry" },
    { key: "results_dir", env: "FABENCH_RESULTS_DIR", type: PATH, default: null, affectsResults: false, inCondition: false,
      defaultText: "<repo>/results", meaning: "Results directory" },
    { key: "corpus_db", env: "FABENCH_CORPUS_DB", type: PATH, default: null, affectsResults: false, inCondition: false,
      meaning: "Corpus used when --frozen-corpus-file is not given" },
    { key: "htmldate_python", env: "HTMLDATE_PYTHON", type: STRING, default: "python3", affectsResults: false, inCondition: true,
      meaning: "Python used by the fetch helper" },
    { key: "frozen_python", env: "FROZEN_PYTHON", type: STRING, default: null, affectsResults: false, inCondition: false,
      defaultText: "HTMLDATE_PYTHON", meaning: "Python used by the tantivy backend" },
    { key: "paths_config", env: "FABENCH_PATHS_CONFIG", type: PATH, default: null, affectsResults: false, inCondition: false,
      meaning: "Non-secret path configuration JSON" },
    { key: "team_env_file", env: "FABENCH_TEAM_ENV_FILE", type: PATH, default: `${TEAM_CONFIG_DIR}/team.env`,
      affectsResults: false, inCondition: false, meaning: "Team env file that API keys are read from" },
    { key: "beta_raven_labels", env: "BETA_RAVEN_LABELS", type: PATH, default: null, affectsResults: true, inCondition: true,
      meaning: "Answer file of the old beta-raven question set" },
    { key: "playwright_browsers_path", env: "PLAYWRIGHT_BROWSERS_PATH", type: PATH, default: null, affectsResults: false,
      inCondition: false, meaning: "Playwright browser directory for the browser fallback" },
  ]),
  ...section("run", [
    { key: "preset", flag: true, type: STRING, default: null, meta: true, affectsResults: false, inCondition: false,
      defaultText: "the preset named in config/default-preset.json", meaning: "Preset name under config/presets/; the old spelling --profile is equivalent" },
    { key: "config", flag: true, type: PATH, default: null, meta: true, repeatable: true, affectsResults: false, inCondition: false,
      meaning: "Override file (JSON with only the keys to change); repeatable, applied in order" },
    { key: "concurrency_file", flag: true, type: PATH, default: null, meta: true, affectsResults: false, inCondition: false,
      meaning: "Old raven.concurrency.v1 concurrency file; applied after --config" },
    { key: "tag", flag: true, type: STRING, default: null, affectsResults: false, inCondition: false,
      defaultText: "derived from --llm", meaning: "Run tag" },
    { key: "condition_preview_file", flag: true, type: PATH, default: null, affectsResults: false, inCondition: false,
      meaning: "Write a condition preview only; no model call, no registration" },
    { key: "registry", flag: true, type: BOOLEAN, default: true, emitDefault: false, affectsResults: false, inCondition: false,
      meaning: "Register in the experiment registry (without it, cells cannot be deduplicated)" },
    { key: "replicate", flag: true, type: BOOLEAN, default: false, emitDefault: false, affectsResults: false, inCondition: false,
      meaning: "Deliberately repeat successful cells; requires --replicate-reason" },
    { key: "replicate_reason", flag: true, type: STRING, default: null, affectsResults: false, inCondition: false,
      meaning: "Reason for a deliberate repeat" },
    { key: "iters", flag: true, type: integer(1), default: 2000, affectsResults: false, inCondition: false,
      meaning: "Bootstrap iterations for printed confidence intervals" },
    { key: "shared_lifecycle", env: "FABENCH_SHARED_LIFECYCLE", type: BOOLEAN, default: false, affectsResults: false, inCondition: false,
      meaning: "Lifecycle flag set by the shared launcher (0 or 1 only)" },
    { key: "registered_notice_policy", env: "FABENCH_REGISTERED_NOTICE_POLICY", type: enumeration("batch-child"), default: null,
      affectsResults: false, inCondition: false, defaultText: "each run notifies on its own", meaning: "Notification mode of continuation-controller child runs" },
    { key: "progress_time_zone", env: "FABENCH_PROGRESS_TIME_ZONE", type: { kind: "time-zone" }, default: "Asia/Shanghai",
      affectsResults: false, inCondition: false, meaning: "Time zone of progress reports" },
    { key: "progress_archive_dir", env: "FABENCH_PROGRESS_ARCHIVE_DIR", type: PATH, default: null, affectsResults: false,
      inCondition: false, meaning: "Archive directory of progress reports" },
    { key: "alert_archive_dir", env: "FABENCH_EXPERIMENT_ALERT_ARCHIVE_DIR", type: PATH, default: null, affectsResults: false,
      inCondition: false, meaning: "Archive directory of experiment alerts" },
  ]),
];

export const PARAMETERS_BY_KEY: ReadonlyMap<string, ParameterSpec> = new Map(RUN_PARAMETERS.map((spec) => [spec.key, spec]));
export const PARAMETERS_BY_FLAG: ReadonlyMap<string, ParameterSpec> = new Map(
  RUN_PARAMETERS.filter((spec) => spec.flag).map((spec) => [spec.flag!, spec]),
);

/** Old spellings that now fail with a pointer instead of being reinterpreted. */
export const REMOVED_FLAGS: Readonly<Record<string, string>> = {
  arms:
    `--arms was removed; use --settings. The arm syntax also changed: an arm now names ` +
    `branches joined with "+", e.g. --settings "none,frozen,frozen+expand,frozen+backsearch".`,
  "max-searches": "--max-searches was removed; use --max-tool-calls (the cap covers search and fetch together)",
};
/**
 * Alternative spellings. `--compare` is the former name of `--settings`; the parameter keeps the
 * key `compare`, so recorded conditions and their ids do not change.
 */
export const FLAG_ALIASES: Readonly<Record<string, string>> = { profile: "preset", compare: "settings" };

/** Default presence of the shared server's frozen-query cache. */
export function sharedFrozenCacheAvailable(): boolean {
  return existsSync(dirname(FROZEN_SHARED_CACHE));
}

export function describeType(type: ParameterType): string {
  switch (type.kind) {
    case "integer":
      return type.max !== undefined
        ? `integer ${type.min ?? "-∞"}–${type.max}`
        : type.min !== undefined ? `integer ≥${type.min}` : "integer";
    case "number":
      return type.positive ? "number >0" : type.nonNegative ? "number ≥0" : "number";
    case "boolean":
      return "boolean (1/0/true/false)";
    case "enum":
      return type.values.join(" | ");
    case "python-float":
      return "Python float (inf, nan accepted)";
    case "python-int":
      return "Python int";
    default:
      return type.kind;
  }
}
