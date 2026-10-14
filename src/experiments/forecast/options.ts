import { join } from "node:path";
import { RESULTS_DIR } from "../../paths.js";
import { DEFAULT_MAX_TOOL_CALLS } from "../../predictors/agentic-search.js";
import {
  frozenSearchDeliveryDefault,
  parseFrozenSearchDelivery,
} from "../../predictors/frozen-search-preview.js";
import { parseToolDelivery } from "../../predictors/tool-content-pages.js";
import { retrievalProfile } from "../../retrieval/quality-profile.js";
import { type DateGateMode } from "../../retrieval/search-backend.js";
import { canonicalArmSpec } from "../experiment-identity.js";
import { selectedQuestionIds } from "../question-selection.js";
import { type ResolveContext, resolveRunParameters } from "../params/resolve.js";

/**
 * Which BackSearch corpora to query.
 *
 * `cc_sec` is refused rather than merely discouraged: the vendor gates SEC filings on the
 * filing date rather than the crawl date, which is the self-reported-date rule this whole
 * benchmark exists to avoid. A run that quietly mixed it in would report one isolation
 * guarantee while a slice of its evidence rested on another.
 */
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

const DEFAULT_COMPARE = "none,frozen,both";
const BRANCHES = [
  "none",
  "frozen",
  "web-filter",
  "backsearch",
  "provided",
] as const;
export type Branch = (typeof BRANCHES)[number];

/**
 * `frozen+backsearch+expand` → branches [frozen, backsearch] with query expansion.
 *
 * A retrieval arm names one or more BRANCHES joined by `+`. Several branches merge into one
 * tool the model cannot tell apart, in the order named — the first branch keeps all its
 * results and each later one contributes only what the earlier ones missed, which is how a
 * merged arm measures the first branch's gap instead of just scoring better.
 *
 * `both` now names the published half-prefix policy (`mixed` is an input alias).
 * The historical n+n frozen/web merge is retired and has no runnable spelling.
 */
function parseSource(spec: string): {
  source: string;
  branches: Branch[];
  expand: boolean;
} {
  const expand = spec.endsWith("+expand");
  const source = (expand ? spec.slice(0, -"+expand".length) : spec).trim();
  const branches = (
    ["both", "mixed"].includes(source) ? "frozen+web-filter" : source
  ).split("+") as Branch[];
  for (const b of branches) {
    if (!(BRANCHES as readonly string[]).includes(b)) {
      throw new Error(
        `unknown evidence source "${spec}" — expected ${BRANCHES.join(", ")} or "both", ` +
          `joined with "+" for a merged arm (e.g. "frozen+backsearch"), ` +
          `optionally with a +expand suffix`,
      );
    }
  }
  if (source === "none" && expand) {
    throw new Error(
      `"none+expand" is not a thing: closed book does not search`,
    );
  }
  if (branches.includes("none") && branches.length > 1) {
    throw new Error(
      `"${spec}": closed book cannot be merged with a retrieval branch`,
    );
  }
  // `provided` supplies its own evidence and never searches, so expansion and merging — both
  // of which are about how a query reaches a backend — have nothing to act on here.
  if (source === "provided" && expand) {
    throw new Error(
      `"provided+expand" is not a thing: a fixed packet is not searched`,
    );
  }
  if (branches.includes("provided") && branches.length > 1) {
    throw new Error(
      `"${spec}": a fixed evidence packet cannot be merged with a search branch`,
    );
  }
  if (new Set(branches).size !== branches.length) {
    throw new Error(`"${spec}" names the same branch twice`);
  }
  return { source, branches, expand };
}

/**
 * Resolve the run parameters (schema defaults → preset → --config files → command line), then
 * read the runner's options from the canonical argument list. The shared launcher's admission
 * resolves the same way, so a direct run, a condition preview and a shared run of the same
 * arguments get the same values.
 */
export function readForecastOptions(raw = process.argv.slice(2), context: ResolveContext = {}) {
  const parameters = resolveRunParameters(raw, context);
  return { ...parseForecastArguments(parameters.args), parameters };
}

/** Options from canonical arguments; values arrive validated and complete from the resolver. */
export function parseForecastArguments(argv: readonly string[]) {
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
  const compareSpecRequested = arg("settings", DEFAULT_COMPARE);
  // Validate every argument before touching the answer key or the corpus. A misuse should
  // fail on the misuse, not on whatever environment variable happens to be missing first.
  const backsearchCorpus = arg("backsearch-corpus", "cc_news");
  const backsearchCorpusNames = backsearchCorpora(backsearchCorpus);
  // One search/fetch tool-call budget shared across arms.
  const maxToolCalls = Number(arg("max-tool-calls", String(DEFAULT_MAX_TOOL_CALLS)));
  const maxResultsPerSearch = Number(arg("max-results-per-search", "20"));
  const webSearchFailureLimit = Number(arg("web-search-failure-limit", "3"));
  const webZeroServedLimit = Number(arg("web-zero-served-limit", "5"));
  // v5 defaults to content; the older v3/v4 default to strict. content hands pages whose date
  // cannot be determined, or whose date is after the anchor, to the content judge; the
  // reasoning and measurements are in the DateGateMode comment in src/retrieval/search-backend.ts.
  // It must enter the condition identity: the two modes behave differently under the same code,
  // so their cells cannot be reused for each other.
  const qualityProfile = retrievalProfile(
    [...argv],
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
    // Read from the parsed arguments, never the process's own argv: `--ids=a,b` and arguments
    // passed programmatically select exactly as the space-separated form does.
    idSelection: selectedQuestionIds(
      argv.includes("--ids") ? arg("ids", "") : undefined,
      argv.includes("--ids-file") ? arg("ids-file", "") : undefined,
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
    compareExplicit: arg("settings", ""),
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

export type ForecastOptions = ReturnType<typeof readForecastOptions>;

export function readForecastArms({
  compareSpecRequested,
  quality,
  frozenArchiveFile,
}: ForecastOptions) {
  // Parsed up front so a typo fails before any model is called rather than after an hour.
  const requestedColumns = compareSpecRequested
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const normalisedColumns = requestedColumns.map(canonicalArmSpec);
  if (normalisedColumns.some((c) => c.usedLegacyWebAlias)) {
    console.warn(
      `    ⚠️  "web" was renamed to "web-filter"; the old name is accepted for this run, but the manifest and results use the new name`,
    );
  }
  const columns = normalisedColumns.map((c) => c.canonical);
  if (new Set(columns).size !== columns.length)
    throw new Error("Duplicate experiment arms (mixed is an alias for both)");
  const compareSpec = columns.join(",");
  let parsed: Map<string, ReturnType<typeof parseSource>>;
  try {
    parsed = new Map(columns.map((c) => [c, parseSource(c)]));
  } catch (e) {
    // A usage mistake deserves the message, not a stack trace: the trace says where the
    // throw happened, which is never what the person mistyping a flag needs to know.
    console.error(`\n${(e as Error).message}\n`);
    process.exit(2);
  }
  if (
    columns.some((c) => parsed.get(c)!.source === "both") &&
    (!quality ||
      columns.some(
        (c) => parsed.get(c)!.source === "both" && parsed.get(c)!.expand,
      ) ||
      frozenArchiveFile)
  )
    throw new Error(
      "both requires quality-v1 without legacy expansion or archive supplements",
    );
  const retrievalColumns = columns.filter(
    (c) => parsed.get(c)!.source !== "none",
  );
  const webFilterColumns = columns.filter((column) =>
    parsed.get(column)!.branches.includes("web-filter"),
  );
  return { columns, compareSpec, parsed, retrievalColumns, webFilterColumns };
}

export type ForecastArms = ReturnType<typeof readForecastArms>;
