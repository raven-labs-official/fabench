import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOCUMENT_POLICY,
  EvidenceStore,
  FrozenWorkerPool,
  WikiSnapshot,
  WikipediaCache,
  createRetrievalRuntime,
} from "../../../vendor/retrieval-infra/src/index.js";
import { FallbackLlmClient } from "../../../vendor/retrieval-infra/src/llm/fallback-client.js";
import { createLlmClient } from "../../llm/benchmark-providers.js";
import { getEnvKey } from "../../llm/load-env.js";
import {
  configureReviewerEffort,
  configureReviewerThinking,
  validateReviewerEffort,
  validateReviewerThinking,
  validateShadowReviewEffort,
} from "../../llm/reviewer-thinking.js";
import { corpusDb } from "../../paths.js";
import { AgenticSearchPredictor } from "../../predictors/agentic-search.js";
import {
  BackSearchBackend,
  type BackSearchMode,
} from "../../retrieval/backsearch-backend.js";
import { ExpandingBackend } from "../../retrieval/expanding-backend.js";
import {
  FrozenWithArchiveBackend,
  openFrozenArchive,
} from "../../retrieval/frozen-with-archive.js";
import { LeakFilter } from "../../retrieval/leak-filter.js";
import { PageDater } from "../../retrieval/page-dater.js";
import {
  FrozenBackend,
  MergeBackend,
  WebSearchBackend,
  type SearchBackend,
} from "../../retrieval/search-backend.js";
import {
  configureSearchHttpConcurrency,
  createSearchProvider,
  type SearchProvider,
} from "../../retrieval/search-providers.js";
import { type AgentTraceSink } from "../../tracing/trace-archive.js";
import type { Question } from "../../types.js";

import type { LlmClient } from "../../llm/benchmark-client.js";
import {
  type Branch,
  type ForecastArms,
  type ForecastOptions,
} from "./options.js";

/** Assemble shared retrieval services and a fresh predictor factory for each arm. */
export function createForecastRetrieval({
  options,
  arms,
  client,
  questions,
  evidenceFile,
  providedEvidence,
}: {
  options: ForecastOptions;
  arms: ForecastArms;
  client: LlmClient;
  questions: Question[];
  evidenceFile: string;
  providedEvidence: Map<string, string>;
}) {
  const {
    maxToolCalls,
    maxResultsPerSearch,
    webSearchFailureLimit,
    webZeroServedLimit,
    qualityProfile,
    quality,
    leakAvailabilityPolicy,
    dateGate,
    effort,
    ledger,
    fetchChars,
    toolDelivery,
    frozenSearchDelivery,
    maxInputTokens,
  } = options;
  const { columns, parsed, retrievalColumns, webFilterColumns } = arms;
  // Share the reviewer cache across questions and arms; keep reviewer and forecaster clients separate.
  const leakArg = options.leakArg;
  const reviewThinking = validateReviewerThinking(
    options.reviewThinkingRequested,
    {
      compare: options.compareExplicit,
      profile: qualityProfile.name,
      model: leakArg,
      fallback: options.leakFallbackArg,
      filter: options.leakFilterArg,
    },
  );
  const reviewEffort = validateReviewerEffort(options.reviewEffortRequested, {
    compare: options.compareExplicit,
    profile: qualityProfile.name,
    model: leakArg,
    fallback: options.leakFallbackArg,
    filter: options.leakFilterArg,
    thinking: reviewThinking,
  });
  const lli = leakArg.indexOf(":");
  const shadowReviewEffort = validateShadowReviewEffort(
    options.shadowReviewEffortRequested,
    {
      compare: options.compareExplicit,
      profile: qualityProfile.name,
      model: leakArg,
      fallback: options.leakFallbackArg,
      filter: options.leakFilterArg,
      thinking: reviewThinking,
      primaryEffort: reviewEffort,
      processing: qualityProfile.contentProcessing,
    },
  );
  const shadowReviewerClient = shadowReviewEffort
    ? configureReviewerEffort(
        createLlmClient(leakArg.slice(0, lli), leakArg.slice(lli + 1)),
        shadowReviewEffort,
      )
    : undefined;
  const leakClient =
    webFilterColumns.length > 0 && options.leakFilterArg === "1"
      ? configureReviewerEffort(
          configureReviewerThinking(
            createLlmClient(
              lli >= 0 ? leakArg.slice(0, lli) : leakArg,
              lli >= 0 ? leakArg.slice(lli + 1) : undefined,
            ),
            reviewThinking,
          ),
          reviewEffort,
        )
      : undefined;
  const leakFallbackArg = options.leakFallbackArg;
  const lfi = leakFallbackArg.indexOf(":");
  const leakFallbackClient = webFilterColumns.length > 0 && leakFallbackArg
    ? createLlmClient(
        lfi >= 0 ? leakFallbackArg.slice(0, lfi) : leakFallbackArg,
        lfi >= 0 ? leakFallbackArg.slice(lfi + 1) : undefined,
      )
    : undefined;
  const leakFilter =
    leakClient && !quality
      ? new LeakFilter(leakClient, {
          fallbackClient: leakFallbackClient,
          availabilityPolicy: leakAvailabilityPolicy,
        })
      : undefined;
  // quality-v1 reviews through one client; with --leak-fallback-llm the primary is preferred and
  // the second model only takes requests the primary cannot admit or serve.
  const reviewerClient =
    quality && leakClient && leakFallbackClient
      ? new FallbackLlmClient(leakClient, leakFallbackClient)
      : leakClient;

  const equivalentModel = qualityProfile.queryExpansionModel;
  const equivalentColon = equivalentModel?.indexOf(":") ?? -1;
  const equivalentClient = equivalentModel
    ? createLlmClient(
        equivalentModel.slice(0, equivalentColon),
        equivalentModel.slice(equivalentColon + 1),
      )
    : undefined;

  // Use the small rewriting model for legacy query expansion.
  const expandClient = columns.some((column) => parsed.get(column)!.expand)
    ? createLlmClient("deepseek", "deepseek-v4-flash")
    : undefined;

  // Share one page dater and its cache across all retrieval arms.
  const qualityArtifacts = quality
    ? new EvidenceStore(qualityProfile.directory!)
    : undefined;
  const dater = new PageDater(
    options.readerEnabled,
    undefined,
    undefined,
    undefined,
    quality
      ? {
          policy: DOCUMENT_POLICY,
          rawDirectory: join(qualityArtifacts!.directory, "raw"),
          browser: options.browserFallback,
        }
      : undefined,
    qualityProfile.acquisition,
  );
  const searchHttpPolicy =
    quality && webFilterColumns.length
      ? configureSearchHttpConcurrency(qualityProfile.searchHttpConcurrency)
      : null;
  const qualityEvidenceProvider =
    quality && webFilterColumns.length
      ? createSearchProvider(options.searchProviderRequested)
      : undefined;
  let wikiSnapshot: WikiSnapshot | undefined;
  let qualityRuntime: ReturnType<typeof createRetrievalRuntime> | undefined;

  const backends = new Map<string, SearchBackend>();
  const searchProviderRequested = options.searchProviderRequested;
  const resolvedSearchProviders = new Set<string>();
  const liveSearchProviders = new Map<string, SearchProvider>();
  const agenticFactories = new Map<
    string,
    (trace: AgentTraceSink, question: Question) => AgenticSearchPredictor
  >();
  let store: FrozenWorkerPool | undefined;
  let corpusPath: string | undefined;
  let frozenArchive: ReturnType<typeof openFrozenArchive> | undefined;
  const frozenArchiveFile = options.frozenArchiveFile.trim();
  if (
    frozenArchiveFile &&
    !columns.some((spec) => parsed.get(spec)!.branches.includes("frozen"))
  )
    throw new Error("--frozen-archive-file requires a frozen retrieval branch");

  if (retrievalColumns.length) {
    if (columns.some((spec) => parsed.get(spec)!.branches.includes("frozen"))) {
      corpusPath = options.frozenCorpusFile || corpusDb();
      if (!quality)
        store = new FrozenWorkerPool({
          corpusPath,
          strategy: "rarity",
          workers: qualityProfile.frozenWorkers,
          maxQueue: qualityProfile.frozenQueue,
        });
    }
    if (qualityProfile.wikiManifestFile) {
      if (!corpusPath) throw new Error("Wiki manifest requires frozen branch");
      const cache = new WikipediaCache(qualityProfile.wikiCachePath!, true);
      try {
        wikiSnapshot = new WikiSnapshot(
          cache,
          JSON.parse(readFileSync(qualityProfile.wikiManifestFile, "utf8")),
          qualityProfile.wikiIndexFile,
        );
        for (const q of questions)
          wikiSnapshot.assertAnchor(q.as_of_date ?? q.resolution_date);
      } finally {
        cache.close();
      }
    }
    const expansionModel = qualityProfile.queryExpansionModel;
    if (expansionModel && !corpusPath)
      throw new Error("query expansion requires frozen branch");
    if (quality)
      qualityRuntime = createRetrievalRuntime({
        shadowReviewerClient,
        sharedCacheDirectory: qualityProfile.sharedCacheDirectory,
        sharedPageCacheDirectory: qualityProfile.sharedPageCacheDirectory,
        fixedDocumentManifestFile: qualityProfile.fixedDocumentManifestFile,
        frozen: corpusPath
          ? {
              corpusPath,
              aliases: qualityProfile.aliases,
              workers: qualityProfile.frozenWorkers,
              maxQueue: qualityProfile.frozenQueue,
              sharedCachePath: qualityProfile.sharedFrozenCachePath,
              sharedCacheSlots: qualityProfile.sharedFrozenCacheSlots,
              wikiCachePath: qualityProfile.wikiCachePath,
              wikiManifestFile: qualityProfile.wikiManifestFile,
              wikiIndexFile: qualityProfile.wikiIndexFile,
            }
          : undefined,
        wikiSnapshot,
        wikiCachePath: qualityProfile.wikiCachePath,
        queryExpansionClient: equivalentClient,
        artifacts: qualityArtifacts!,
        dater,
        provider: qualityEvidenceProvider,
        reviewerClient,
        reviewOptions: {
          cacheDirectory: join(qualityArtifacts!.directory, "review-cache"),
          concurrency: qualityProfile.reviewConcurrency,
          processing: qualityProfile.contentProcessing,
          searchDelivery: qualityProfile.searchDelivery,
          sourceManifestFile: qualityProfile.sourceManifestFile,
        },
        cleaningOptions: { concurrency: qualityProfile.cleaningConcurrency },
        webExecution: {
          candidateConcurrency: qualityProfile.candidateConcurrency,
          scheduling: qualityProfile.scheduling,
        },
      });
    if (frozenArchiveFile)
      frozenArchive = openFrozenArchive(
        frozenArchiveFile,
        corpusPath!,
        questions.map((q) => q.as_of_date ?? q.resolution_date),
      );
    for (const spec of retrievalColumns) {
      const { source: world, branches, expand } = parsed.get(spec)!;
      if (world === "provided") {
        if (!providedEvidence.size) {
          throw new Error(
            `arm "${spec}" needs --evidence-file: a provided arm with an empty packet is just ` +
              `the closed-book arm wearing another name, and would be scored as if it were not`,
          );
        }
        // The provided arm reads a fixed packet with zero tool calls. Require coverage for the selected questions.
        const uncovered = questions
          .map((q) => q.question_id)
          .filter((id) => !providedEvidence.has(id));
        if (uncovered.length) {
          throw new Error(
            `${uncovered.length} of ${questions.length} questions have no evidence in ` +
              `${evidenceFile} (first: ${uncovered.slice(0, 3).join(", ")}). Fix the packet or ` +
              `the id list; a missing packet entry would otherwise be scored as a forecast made ` +
              `on nothing.`,
          );
        }
        agenticFactories.set(spec, (trace, question) => {
          const packet = providedEvidence.get(question.question_id)!;
          return new AgenticSearchPredictor(client, undefined, {
            maxToolCalls: 0,
            effort: effort || undefined,
            ledger,
            providedEvidence: packet,
            trace,
          });
        });
        continue;
      }
      // Keep expanded and unexpanded arms on distinct backends.
      const key = expand ? `${world}+expand` : world;
      if (!backends.has(key)) {
        const wrap = (b: SearchBackend) =>
          expand
            ? new ExpandingBackend(b, expandClient!, options.expandVariants)
            : b;
        // Build each named branch, then merge if there is more than one. Expansion wraps the
        // MERGED backend, not each branch: expanding per branch would rewrite the same query
        // several times over and bill for it once per branch.
        const build = (b: Branch): SearchBackend => {
          if (b === "frozen") {
            const news = quality
              ? qualityRuntime!.createBackend("frozen")
              : new FrozenBackend(store!);
            return frozenArchive
              ? new FrozenWithArchiveBackend(news, frozenArchive.backend)
              : news;
          }
          if (b === "backsearch") {
            // No PageDater and no LeakFilter: this archive states each hit's crawl date and
            // gates on it, so fetching the page to recover an age it already gave us would be
            // paying twice for one fact. See src/retrieval/backsearch-backend.ts.
            return new BackSearchBackend({
              apiKey: getEnvKey("OPENREWARD_API_KEY") ?? "",
              mode: options.backsearchMode as BackSearchMode,
              corpora: options.backsearchCorpusNames,
              fetchChars,
            });
          }
          // The live path cannot run unfiltered: its results routinely carry post-anchor
          // content, so an unfiltered web arm would measure leakage, not retrieval.
          if (!leakFilter && !qualityRuntime?.reviewer)
            throw new Error(
              `arm "${spec}" needs the leak filter; do not pass --leak-filter 0`,
            );
          const searchProvider =
            qualityEvidenceProvider ??
            createSearchProvider(searchProviderRequested);
          resolvedSearchProviders.add(searchProvider.name);
          liveSearchProviders.set(searchProvider.name, searchProvider);
          if (quality) return qualityRuntime!.createBackend("web-filter");
          return new WebSearchBackend(
            searchProvider,
            dater,
            leakFilter!,
            {
              maxConsecutiveSearchFailures: webSearchFailureLimit,
              maxConsecutiveZeroServed: webZeroServedLimit,
            },
            dateGate,
          );
        };
        const built =
          world === "both"
            ? [qualityRuntime!.createBackend("mixed")]
            : branches.map(build);
        if (world === "both") {
          resolvedSearchProviders.add(qualityEvidenceProvider!.name);
          liveSearchProviders.set(
            qualityEvidenceProvider!.name,
            qualityEvidenceProvider!,
          );
        }
        backends.set(
          key,
          wrap(built.length === 1 ? built[0]! : new MergeBackend(built, world)),
        );
      }
      const backend = backends.get(key)!;
      // Create a predictor per cell so concurrent questions own separate tool traces.
      agenticFactories.set(
        spec,
        (trace, _question) =>
          new AgenticSearchPredictor(client, backend, {
            maxToolCalls,
            maxResultsPerSearch,
            fetchChars,
            toolDelivery,
            frozenSearchDelivery:
              backend.name === "mixed" ||
              (backend.name === "frozen" && backend.fullTextResults)
                ? frozenSearchDelivery
                : "fulltext",
            maxInputTokens,
            effort: effort || undefined,
            ledger,
            trace,
          }),
      );
    }
  }

  return {
    leakArg,
    reviewThinking,
    reviewEffort,
    shadowReviewEffort,
    leakClient,
    leakFallbackClient,
    leakFilter,
    reviewerClient,
    equivalentClient,
    expandClient,
    dater,
    searchHttpPolicy,
    qualityRuntime,
    wikiSnapshot,
    backends,
    searchProviderRequested,
    resolvedSearchProviders,
    liveSearchProviders,
    agenticFactories,
    store,
    corpusPath,
    frozenArchive,
    close() {
      frozenArchive?.close();
      qualityRuntime?.close();
      wikiSnapshot?.close();
      store?.close();
      dater.close();
    },
  };
}

export type ForecastRetrieval = ReturnType<typeof createForecastRetrieval>;
