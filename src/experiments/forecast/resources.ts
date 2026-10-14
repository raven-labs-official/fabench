import type { LlmClient } from "../../llm/benchmark-client.js";
import type { ForecastRetrieval } from "./retrieval.js";

export function createResourceCounters(columns: string[]) {
  return new Map(
    columns.map((l) => [
      l,
      {
        cells: 0,
        reused: 0,
        failed: 0,
        interrupted: 0,
        cost: 0,
        failedCost: 0,
        inTok: 0,
        outTok: 0,
        reasoningTok: 0,
        ms: 0,
        modelMs: 0,
        toolMs: 0,
        toolCalls: 0,
        searchCalls: 0,
        fetchCalls: 0,
        fetchedDocuments: 0,
        searchResultUrls: 0,
        uniqueSearchUrls: 0,
        uniqueFetchedUrls: 0,
        searchSnippetChars: 0,
        fetchedDocumentChars: 0,
        budgetReached: 0,
        budgetReachedOnFailed: 0,
        overBudgetRequested: 0,
        overBudgetRequestedOnFailed: 0,
      },
    ]),
  );
}

function clientUsdCostKnown(c: LlmClient | undefined): boolean {
  const pricing = c?.traceMetadata?.pricing as
    { known?: unknown; usd_cost_known?: unknown } | undefined;
  return pricing?.usd_cost_known === undefined
    ? pricing?.known === true
    : pricing.usd_cost_known === true;
}

export function snapshotPipelineResources({
  retrieval,
  client,
  conditions,
  quality,
  llmCost,
  readerEnabled,
}: {
  retrieval: ForecastRetrieval;
  client: LlmClient;
  conditions: { filter_model: string | null; search_expansion: boolean }[];
  quality: boolean;
  llmCost: number;
  readerEnabled: boolean;
}) {
  const {
    backends,
    qualityRuntime,
    leakFilter,
    reviewerClient,
    leakClient,
    expandClient,
    equivalentClient,
    dater,
  } = retrieval;
  const backendStats = Object.fromEntries(
    [...backends].map(([name, backend]) => [name, backend.stats()]),
  );
  const queryExpansionCostUsd = Object.values(backendStats).reduce(
    (sum, stats) =>
      sum + Number((stats as Record<string, number>).expand_cost_usd ?? 0),
    qualityRuntime?.expander?.snapshot().costUsd ?? 0,
  );
  const leakFilterStats =
    qualityRuntime?.reviewer?.snapshot() ?? leakFilter?.snapshot() ?? null;
  const cleaningStats = qualityRuntime?.cleaner?.snapshot() ?? null;
  const shadowReviewStats = qualityRuntime?.shadowReviewer?.snapshot() ?? null;
  const usesWebFilter = conditions.some((c) => c.filter_model != null);
  const usesLegacyExpansion = conditions.some((c) => c.search_expansion);
  const usesExpansion =
    usesLegacyExpansion || Boolean(qualityRuntime?.expander);
  const forecasterPricingKnown = clientUsdCostKnown(client);
  const filterPricingKnown =
    !usesWebFilter || clientUsdCostKnown(quality ? reviewerClient : leakClient);
  const expansionPricingKnown =
    (!usesLegacyExpansion || clientUsdCostKnown(expandClient)) &&
    (!qualityRuntime?.expander || clientUsdCostKnown(equivalentClient));
  const unpricedComponents = [
    ...(!forecasterPricingKnown ? ["forecaster_llm"] : []),
    ...(cleaningStats && !filterPricingKnown ? ["reader_cleaning_llm"] : []),
    ...(usesWebFilter && !filterPricingKnown ? ["leak_filter_llm"] : []),
    ...(usesExpansion && !expansionPricingKnown ? ["query_expansion_llm"] : []),
    ...(usesWebFilter
      ? ["search_provider", ...(quality && readerEnabled ? ["reader"] : [])]
      : []),
  ];
  // A subscription makes the component's full price unknown, but must not hide
  // the metered USD spent by its fallback. Clients report zero for unpriced usage.
  const reportedModelUsd = {
    forecaster_llm: llmCost,
    leak_filter_llm: leakFilterStats?.costUsd ?? 0,
    reader_cleaning_llm: cleaningStats?.costUsd ?? 0,
    query_expansion_llm: queryExpansionCostUsd,
    ...(shadowReviewStats
      ? { shadow_review_llm: shadowReviewStats.costUsd }
      : {}),
  };
  const knownTotalUsd = Object.values(reportedModelUsd).reduce(
    (sum, usd) => sum + usd,
    0,
  );
  return {
    backend_stats: backendStats,
    page_fetch: dater.snapshot(),
    leak_filter: leakFilterStats,
    ...(shadowReviewStats ? { shadow_review: shadowReviewStats } : {}),
    reader_cleaning: cleaningStats,
    costs: {
      scope: "current-run-incremental",
      forecaster_llm_usd: forecasterPricingKnown ? llmCost : null,
      leak_filter_llm_usd: filterPricingKnown
        ? (leakFilterStats?.costUsd ?? 0)
        : null,
      reader_cleaning_llm_usd: filterPricingKnown
        ? (cleaningStats?.costUsd ?? 0)
        : null,
      query_expansion_llm_usd: expansionPricingKnown
        ? queryExpansionCostUsd
        : null,
      ...(shadowReviewStats
        ? { shadow_review_llm_usd: shadowReviewStats.costUsd }
        : {}),
      search_provider_usd: null,
      reported_model_usd: reportedModelUsd,
      known_total_usd: knownTotalUsd,
      complete: unpricedComponents.length === 0,
      unpriced_components: unpricedComponents,
    },
  };
}

export function buildResourceRows({
  columns,
  resources,
  conditionsByArm,
  maxToolCalls,
  client,
}: {
  columns: string[];
  resources: ReturnType<typeof createResourceCounters>;
  conditionsByArm: Map<
    string,
    {
      max_tool_calls: number;
      max_search_calls: number;
      max_results_per_search: number | null;
      budget_scope: string;
    }
  >;
  maxToolCalls: number;
  client: LlmClient;
}) {
  return columns.map((arm) => {
    const r = resources.get(arm)!;
    const nc = Math.max(1, r.cells);
    return {
      arm,
      cells: r.cells,
      reused: r.reused,
      resourceScope:
        r.reused > 0
          ? "new-cells-only; reused-cell resources remain in source runs"
          : "all-cells",
      failed: r.failed,
      interrupted: r.interrupted,
      meanInputTokens: Math.round(r.inTok / nc),
      meanOutputTokens: Math.round(r.outTok / nc),
      meanReasoningTokens: Math.round(r.reasoningTok / nc),
      meanToolCalls: +(r.toolCalls / nc).toFixed(1),
      meanSearchCalls: +(r.searchCalls / nc).toFixed(1),
      meanFetchCalls: +(r.fetchCalls / nc).toFixed(1),
      meanFetchedDocuments: +(r.fetchedDocuments / nc).toFixed(1),
      meanReturnedUrls: +(r.searchResultUrls / nc).toFixed(1),
      meanUniqueReturnedUrls: +(r.uniqueSearchUrls / nc).toFixed(1),
      meanUniqueFetchedUrls: +(r.uniqueFetchedUrls / nc).toFixed(1),
      meanSearchSnippetChars: Math.round(r.searchSnippetChars / nc),
      meanFetchedDocumentChars: Math.round(r.fetchedDocumentChars / nc),
      maxToolCalls: conditionsByArm.get(arm)?.max_tool_calls ?? maxToolCalls,
      maxSearchCalls:
        conditionsByArm.get(arm)?.max_search_calls ?? maxToolCalls,
      maxResultsPerSearch:
        conditionsByArm.get(arm)?.max_results_per_search ?? null,
      budgetScope:
        conditionsByArm.get(arm)?.budget_scope ??
        "shared-across-search-and-fetch",
      budgetEvaluatedCells: r.cells + r.failed,
      budgetReachedCells: r.budgetReached + r.budgetReachedOnFailed,
      budgetReachedRate: +(
        (r.budgetReached + r.budgetReachedOnFailed) /
        Math.max(1, r.cells + r.failed)
      ).toFixed(4),
      successfulBudgetReachedCells: r.budgetReached,
      successfulBudgetReachedRate: +(r.budgetReached / nc).toFixed(4),
      overBudgetRequestCells:
        r.overBudgetRequested + r.overBudgetRequestedOnFailed,
      overBudgetRequestRate: +(
        (r.overBudgetRequested + r.overBudgetRequestedOnFailed) /
        Math.max(1, r.cells + r.failed)
      ).toFixed(4),
      successfulOverBudgetRequestCells: r.overBudgetRequested,
      successfulOverBudgetRequestRate: +(r.overBudgetRequested / nc).toFixed(4),
      meanSeconds: +(r.ms / nc / 1000).toFixed(1),
      meanModelSeconds: +(r.modelMs / nc / 1000).toFixed(1),
      meanToolSeconds: +(r.toolMs / nc / 1000).toFixed(1),
      modelTimeShare: +(r.modelMs / Math.max(1, r.ms)).toFixed(4),
      toolTimeShare: +(r.toolMs / Math.max(1, r.ms)).toFixed(4),
      meanCostUsd: clientUsdCostKnown(client)
        ? +(r.cost / nc).toFixed(5)
        : null,
      failedCostUsd: clientUsdCostKnown(client)
        ? +r.failedCost.toFixed(4)
        : null,
      totalCostUsd: clientUsdCostKnown(client)
        ? +(r.cost + r.failedCost).toFixed(4)
        : null,
    };
  });
}

export type ResourceRow = ReturnType<typeof buildResourceRows>[number];
