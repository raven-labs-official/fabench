import { statSync } from "node:fs";
import {
  CONCEPT_QUERY_POLICY,
  DOCUMENT_POLICY,
  webExecutionPolicy,
} from "../../../vendor/retrieval-infra/src/index.js";
import { APPROVED_SUMMARY_POLICY } from "../../../vendor/retrieval-infra/src/retrieval/approved-summary.js";
import { MIXED_POLICY } from "../../../vendor/retrieval-infra/src/retrieval/mixed-backend.js";
import { FROZEN_QUERY_POLICY } from "../../corpus/query-identity.js";
import { corpusRetrievalIdentity } from "../../corpus/retrieval-identity.js";
import { betaRavenQuestionSetIdentity } from "../../datasets/beta-raven-bench.js";
import { RATE_POLICY } from "../../llm/shared-rate-limit.js";
import { FORECAST_PARSE_POLICY } from "../../predictors/forecast-response.js";
import { FROZEN_LEAD_POLICY } from "../../predictors/frozen-search-preview.js";
import { PAGED_TOOL_POLICY } from "../../predictors/tool-content-pages.js";
import { assertQualityCorpus } from "../../retrieval/quality-profile.js";
import { BRAVE_SEARCH_CONFIG } from "../../retrieval/search-providers.js";
import { sha256Json } from "../../tracing/trace-archive.js";
import { toolBudgetIdentity } from "../experiment-identity.js";
import { experimentCodeIdentity } from "../registry.js";

import type { LlmClient } from "../../llm/benchmark-client.js";
import type { ForecastArms, ForecastOptions } from "./options.js";
import type {
  loadForecastQuestions,
  loadProvidedEvidence,
} from "./questions.js";
import type { ForecastRetrieval } from "./retrieval.js";
import { projectEnv } from "../../env-names.js";

/** Describe conditions and run metadata using the assembled experiment components. */
/** Backsearch settings that differ from the defaults every earlier backsearch condition used. */
function backsearchIdentity(options: ForecastOptions) {
  const coverageStart = process.env.BACKSEARCH_COVERAGE_START ?? "2025-12-01";
  return {
    ...(options.backsearchMode !== "hybrid" ? { backsearch_mode: options.backsearchMode } : {}),
    ...(options.backsearchCorpus !== "cc_news" ? { backsearch_corpus: options.backsearchCorpus } : {}),
    ...(coverageStart !== "2025-12-01" ? { backsearch_coverage_start: coverageStart } : {}),
  };
}

export function buildForecastRunConfig({
  options,
  arms,
  retrieval,
  dataset,
  evidence,
  evidenceFile,
  client,
}: {
  options: ForecastOptions;
  arms: ForecastArms;
  retrieval: ForecastRetrieval;
  dataset: ReturnType<typeof loadForecastQuestions>;
  evidence: ReturnType<typeof loadProvidedEvidence>;
  evidenceFile: string;
  client: LlmClient;
}) {
  const {
    conc,
    iters,
    compareSpecRequested,
    maxToolCalls,
    maxResultsPerSearch,
    webSearchFailureLimit,
    webZeroServedLimit,
    qualityProfile,
    quality,
    dateGate,
    llm,
    effort,
    ledger,
    fetchChars,
    toolDelivery,
    frozenSearchDelivery,
    maxInputTokens,
  } = options;
  const { columns, compareSpec, parsed, webFilterColumns } = arms;
  const {
    leakArg,
    reviewThinking,
    reviewEffort,
    shadowReviewEffort,
    leakClient,
    leakFallbackClient,
    leakFilter,
    expandClient,
    dater,
    searchHttpPolicy,
    qualityRuntime,
    wikiSnapshot,
    searchProviderRequested,
    resolvedSearchProviders,
    corpusPath,
    frozenArchive,
  } = retrieval;
  const {
    environmentAdmission,
    questionPool,
    questions,
    includeChinaFiltered,
    excluded,
  } = dataset;
  const { evidenceSha, evidenceQuestionCount } = evidence;
  const tag = (options.tag || llm.replace(/[^a-z0-9.]+/gi, "-")).replace(
    /^-|-$/g,
    "",
  );
  const corpusStat = corpusPath ? statSync(corpusPath) : undefined;
  const corpusTreatment = corpusPath
    ? corpusRetrievalIdentity(corpusPath)
    : null;
  if (
    quality &&
    columns.some((c) => parsed.get(c)!.branches.includes("frozen"))
  )
    assertQualityCorpus(
      corpusTreatment,
      questions.map((q) => q.as_of_date ?? q.resolution_date),
    );
  const selectedQuestionsSha256 = sha256Json(
    questions.map((q) => ({
      question_id: q.question_id,
      question_text: q.question_text,
      resolution_criteria: q.resolution_criteria,
      resolution_date: q.resolution_date,
      as_of_date: q.as_of_date,
    })),
  );
  const questionSet = questionPool
    ? {
        ...questionPool.identity,
        split: null,
        selector_version: null,
        generated_at_utc: null,
        manifest_schema_version: null,
        manifest_sha256: questionPool.identity.file_sha256,
        collection: "question-pool" as const,
      }
    : betaRavenQuestionSetIdentity("selected_300");
  const codeIdentity = experimentCodeIdentity();
  const questionSampleId =
    `${questionSet.question_set_id}:n${questions.length}:` +
    selectedQuestionsSha256.slice(0, 12);
  const forecasterReasoning = client.reasoningConfiguration?.(
    effort || undefined,
  ) ?? {
    reasoning_mode: null,
    thinking_effort: effort || null,
    requested_thinking_effort: effort || null,
    source: effort ? ("explicit" as const) : ("provider-default" as const),
    api_parameters: {},
  };
  const leakReasoning = leakClient?.reasoningConfiguration?.() ?? null;
  const leakFallbackReasoning =
    leakFallbackClient?.reasoningConfiguration?.() ?? null;
  const leakPolicy =
    qualityRuntime?.reviewer?.configuration() ??
    leakFilter?.configuration() ??
    null;
  const expansionReasoning = expandClient?.reasoningConfiguration?.() ?? null;
  const conditions = columns.map((arm) => {
    const armConfig = parsed.get(arm)!;
    const retrievalEnabled = armConfig.source !== "none";
    const usesWebFilter = armConfig.branches.includes("web-filter");
    const frozenLeadDelivery =
      quality &&
      ["frozen", "both"].includes(armConfig.source) &&
      !armConfig.expand &&
      !frozenArchive &&
      frozenSearchDelivery === "lead";
    const toolBudget = toolBudgetIdentity(
      retrievalEnabled,
      maxToolCalls,
      maxResultsPerSearch,
    );
    const identity = {
      protocol_version: "raven.forecast-value.v1",
      code_fingerprint_sha256: codeIdentity.source_fingerprint_sha256,
      question_set_id: questionSet.question_set_id,
      model: client.id,
      model_endpoint: client.traceMetadata?.base_url ?? null,
      model_request_parameters: forecasterReasoning.api_parameters,
      reasoning_mode: forecasterReasoning.reasoning_mode,
      thinking_effort: forecasterReasoning.thinking_effort,
      requested_thinking_effort: forecasterReasoning.requested_thinking_effort,
      reasoning_source: forecasterReasoning.source,
      ...(questions.some((q) => q.response_format)
        ? { response_parse_policy: FORECAST_PARSE_POLICY }
        : {}),
      reasoning_history_replay: forecasterReasoning.history_replay ?? null,
      harness: client.traceMetadata?.harness ?? "raven",
      environment_contract_sha256:
        environmentAdmission?.contract_sha256 ?? null,
      api_admission_policy: projectEnv("FABENCH_API_ADMISSION_DB")
        ? RATE_POLICY
        : null,
      search_type: armConfig.source,
      ...(armConfig.source === "both"
        ? { retrieval_mixed_policy: MIXED_POLICY }
        : {}),
      ...(retrievalEnabled
        ? {
            retrieval_tool_delivery: toolDelivery,
            retrieval_tool_delivery_policy:
              toolDelivery === "paged" ? PAGED_TOOL_POLICY : null,
          }
        : {}),
      // The corpus/index is part of the treatment, even outside the formal shared
      // environment contract. Merely writing its path on a run card permits the
      // registry to reuse an ordinary-corpus result for an isolated historical index.
      retrieval_corpus: armConfig.branches.includes("frozen")
        ? corpusTreatment
        : null,
      ...(frozenLeadDelivery
        ? {
            retrieval_frozen_search_delivery: "lead",
            retrieval_frozen_search_policy: FROZEN_LEAD_POLICY,
          }
        : {}),
      ...(armConfig.branches.includes("frozen")
        ? {
            retrieval_query_policy: quality
              ? CONCEPT_QUERY_POLICY
              : FROZEN_QUERY_POLICY,
          }
        : {}),
      ...(quality && (usesWebFilter || armConfig.branches.includes("frozen"))
        ? {
            retrieval_profile: "quality-v1",
            retrieval_entrypoint: "retrieval-infra-runtime-v1",
            retrieval_browse_policy:
              armConfig.source !== "both" &&
              armConfig.branches.includes("frozen")
                ? "entity-capture-pagination-v1"
                : null,
            retrieval_search_content:
              armConfig.source === "both"
                ? {
                    frozen: frozenLeadDelivery
                      ? FROZEN_LEAD_POLICY.version
                      : "full-document-text",
                    web:
                      qualityProfile.searchDelivery === "summary"
                        ? APPROVED_SUMMARY_POLICY
                        : "full-document-text",
                  }
                : frozenLeadDelivery
                  ? FROZEN_LEAD_POLICY.version
                  : usesWebFilter && qualityProfile.searchDelivery === "summary"
                    ? APPROVED_SUMMARY_POLICY
                    : "full-document-text",
            retrieval_return_chars: 0,
            retrieval_content_policy: usesWebFilter
              ? DOCUMENT_POLICY
              : "existing-captured-text",
            reader_cleaning: usesWebFilter
              ? (qualityRuntime?.cleaner?.configuration() ?? null)
              : null,
            retrieval_execution_policy: usesWebFilter
              ? webExecutionPolicy({
                  candidateConcurrency: qualityProfile.candidateConcurrency,
                  scheduling: qualityProfile.scheduling,
                  ...(armConfig.source === "both"
                    ? { fixedCandidatePrefix: true }
                    : {}),
                })
              : null,
            retrieval_search_http_policy: usesWebFilter
              ? searchHttpPolicy
              : null,
            retrieval_acquisition_execution: usesWebFilter
              ? dater.configuration().concurrency
              : null,
            retrieval_frozen_execution: armConfig.branches.includes("frozen")
              ? {
                  workers: qualityProfile.frozenWorkers,
                  maxQueue: qualityProfile.frozenQueue,
                  ...(qualityProfile.sharedFrozenCachePath
                    ? {
                        shared_cache: {
                          path: qualityProfile.sharedFrozenCachePath,
                          policy: "verified-fts-rowids-fifo-v1",
                          global_slots:
                            qualityProfile.sharedFrozenCacheSlots ?? 4,
                        },
                      }
                    : {}),
                }
              : null,
            retrieval_fixed_documents: usesWebFilter
              ? (qualityRuntime?.fixedDocuments ?? null)
              : null,
            ...(usesWebFilter && qualityRuntime?.sharedPageSnapshot
              ? {
                  retrieval_shared_page_snapshot:
                    qualityRuntime.sharedPageSnapshot,
                }
              : {}),
            retrieval_wikipedia_policy: usesWebFilter
              ? "pre-anchor-revision"
              : null,
            retrieval_wiki_snapshot: armConfig.branches.includes("frozen")
              ? (wikiSnapshot?.identity ?? null)
              : null,
            retrieval_query_expansion: armConfig.branches.includes("frozen")
              ? (qualityRuntime?.expander?.configuration() ?? null)
              : null,
            retrieval_query_aliases: armConfig.branches.includes("frozen")
              ? qualityProfile.aliases
              : null,
          }
        : {}),
      ...(armConfig.branches.includes("frozen") && frozenArchive
        ? { retrieval_archive_supplement: frozenArchive.identity }
        : {}),
      search_expansion: armConfig.expand,
      // Result-affecting settings that older conditions did not record appear only when they
      // differ from the value those conditions used, so unchanged runs keep their identity.
      ...(ledger ? { ledger: "on" } : {}),
      ...(armConfig.expand && options.expandVariants !== 3
        ? { query_expansion_variants: options.expandVariants }
        : {}),
      ...(retrievalEnabled && toolDelivery !== "paged" && fetchChars !== 0
        ? { fetch_chars: fetchChars }
        : {}),
      ...(armConfig.source === "backsearch" ? backsearchIdentity(options) : {}),
      date_gate: usesWebFilter
        ? quality
          ? "retrieved-evidence"
          : dateGate
        : null,
      ...toolBudget,
      // Conditional spread, not `max_input_tokens: maxInputTokens || null`: adding an
      // unconditional key would rehash every condition_id in the registry, so runs that never
      // used a cap would stop matching the cells they already own. The key appears only when a
      // cap is actually in force, which is also exactly when the model reads something
      // different and the cells must NOT dedupe against the uncapped ones.
      ...(maxInputTokens > 0 ? { max_input_tokens: maxInputTokens } : {}),
      filter_model: usesWebFilter ? (leakClient?.id ?? null) : null,
      filter_reasoning: usesWebFilter ? leakReasoning : null,
      filter_fallback_model: usesWebFilter
        ? (leakFallbackClient?.id ?? null)
        : null,
      filter_fallback_reasoning: usesWebFilter ? leakFallbackReasoning : null,
      filter_policy: usesWebFilter ? leakPolicy : null,
      query_expansion_model: armConfig.expand ? expandClient!.id : null,
      query_expansion_reasoning: armConfig.expand ? expansionReasoning : null,
      search_provider: usesWebFilter
        ? [...resolvedSearchProviders].sort().join(",") || null
        : null,
      ...(usesWebFilter && resolvedSearchProviders.has("brave")
        ? { brave_search_config: BRAVE_SEARCH_CONFIG }
        : {}),
      web_search_failure_limit: usesWebFilter
        ? quality
          ? 1
          : webSearchFailureLimit
        : null,
      web_zero_served_policy: usesWebFilter
        ? quality
          ? "record-only"
          : "warning-only"
        : null,
      web_zero_served_warning_threshold: usesWebFilter
        ? quality
          ? null
          : webZeroServedLimit
        : null,
      // Include the fixed evidence packet hash in the condition identity.
      evidence_packet_sha256:
        armConfig.source === "provided" ? evidenceSha : null,
    };
    return {
      condition_id: `raven-condition:${sha256Json({ arm, ...identity }).slice(0, 16)}`,
      arm,
      question_sample_id: questionSampleId,
      ...identity,
    };
  });
  const conditionsByArm = new Map(conditions.map((c) => [c.arm, c]));
  const runConfig: Record<string, unknown> = {
    // Every resolved parameter with the layer it came from. A shared run keeps admission's
    // record, which still knows the preset and override files behind each admitted argument.
    parameters: environmentAdmission?.parameters ?? options.parameters?.summary() ?? null,
    dataset: questionPool
      ? `question-pool/${questionPool.identity.file}`
      : "beta-raven-bench/selected_300",
    question_set: questionSet,
    question_set_id: questionSet.question_set_id,
    question_filter: {
      include_china_filtered: includeChinaFiltered,
      china_filtered_question_ids: excluded.map(
        (question) => question.question_id,
      ),
    },
    question_sample_id: questionSampleId,
    selected_question_ids: questions.map((q) => q.question_id),
    selected_questions_sha256: selectedQuestionsSha256,
    llm,
    model_concurrency: options.modelConcurrency ?? null,
    llm_client: { id: client.id, ...(client.traceMetadata ?? {}) },
    reasoning: forecasterReasoning,
    reasoning_mode: forecasterReasoning.reasoning_mode,
    thinking_effort: forecasterReasoning.thinking_effort,
    requested_thinking_effort: forecasterReasoning.requested_thinking_effort,
    effort: effort || null,
    harness: client.traceMetadata?.harness ?? "raven",
    environment_admission: environmentAdmission,
    api_admission_policy: projectEnv("FABENCH_API_ADMISSION_DB")
      ? RATE_POLICY
      : null,
    code_identity: codeIdentity,
    compare_requested: compareSpecRequested,
    compare: compareSpec,
    conditions,
    maxToolCalls,
    maxResultsPerSearch,
    // Legacy output key retained so older leaderboard versions can still compare new runs.
    maxSearches: maxToolCalls,
    fetchChars: fetchChars === 0 ? "whole article" : fetchChars,
    toolDelivery,
    toolDeliveryPolicy: toolDelivery === "paged" ? PAGED_TOOL_POLICY : null,
    frozenSearchDelivery,
    maxInputTokens: maxInputTokens === 0 ? "uncapped" : maxInputTokens,
    searchProvider: searchProviderRequested,
    searchProviderResolved: [...resolvedSearchProviders].sort(),
    webFilterCircuitBreaker: {
      enabled: webFilterColumns.length > 0,
      preflight: "page-dater-helper-plus-jina-live-read",
      maxConsecutiveSearchFailures: webSearchFailureLimit,
      zeroServedPolicy: "warning-only",
      zeroServedWarningThreshold: webZeroServedLimit,
      hardFailureSignals: [
        "search-provider-consecutive-failures",
        "page-dater-helper-failure",
        "jina-reader-auth-or-balance-failure",
        "leak-filter-review-failure",
      ],
      scope: "all-arms-containing-web-filter",
    },
    backsearchMode: columns.some((c) => parsed.get(c)?.source === "backsearch")
      ? options.backsearchMode
      : undefined,
    backsearchCorpus: columns.some(
      (c) => parsed.get(c)?.source === "backsearch",
    )
      ? options.backsearchCorpus
      : undefined,
    reader: options.readerEnabled ? "on" : "off",
    // Recorded on the run card because it changes the output contract, not just a knob: a
    // ledger run and a v1 run are not interchangeable results for the same cell.
    ledger: ledger ? "on" : "off",
    // The packet is part of what produced the numbers, so it is pinned by hash: two runs of a
    // `provided` arm are only comparable if they were handed the same evidence.
    evidenceFile: evidenceFile || null,
    evidenceSha256: evidenceSha || null,
    evidenceQuestions: evidenceQuestionCount || null,
    pageDater: dater.configuration(),
    retrievalProfile: qualityProfile.name,
    retrievalEvidenceDirectory: qualityProfile.directory,
    expandVariants: options.expandVariants,
    leakFilter: leakFilter || qualityRuntime?.reviewer ? leakArg : "off",
    leakFilterClient: leakClient
      ? { id: leakClient.id, ...(leakClient.traceMetadata ?? {}) }
      : null,
    reviewThinking: reviewThinking ?? null,
    reviewEffort: reviewEffort ?? null,
    shadowReviewEffort: shadowReviewEffort ?? null,
    leakFilterReasoning: leakReasoning,
    leakFilterPolicy: leakPolicy,
    queryExpansionClient: expandClient
      ? { id: expandClient.id, ...(expandClient.traceMetadata ?? {}) }
      : null,
    queryExpansionReasoning: expansionReasoning,
    conc,
    bootstrapIters: iters,
    runAtUtc: new Date().toISOString(),
    corpus: corpusPath
      ? {
          path: corpusPath,
          size_bytes: corpusStat?.size ?? null,
          mtime_utc: corpusStat?.mtime.toISOString() ?? null,
          // A content checksum needs to come from the corpus build manifest. Hashing a 150 GiB
          // SQLite file at run start would itself be an hour-scale experiment side effect.
          sha256: null,
          retrieval_identity: corpusTreatment,
        }
      : null,
  };
  return { tag, codeIdentity, conditions, conditionsByArm, runConfig };
}
