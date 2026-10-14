/** Run an experiment: load questions, assemble services, claim cells, predict, and report.
 * Module responsibilities: docs/architecture.md.
 * Formal runs enter through tools/run-shared-experiment.sh.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { limitModelConcurrency } from "../resources/model-concurrency.js";
import { createLlmClient } from "../llm/benchmark-providers.js";
import {
  isNonRetryableProviderApiError,
  type ProviderApiError,
} from "../llm/openai-compatible.js";
import { RESULTS_DIR } from "../paths.js";
import { AgenticSearchPredictor } from "../predictors/agentic-search.js";
import { FORECAST_PARSE_POLICY } from "../predictors/forecast-response.js";
import { BudgetTier, NullRetrievalEnv } from "../predictors/types.js";
import {
  RetrievalInfrastructureError,
  isRetrievalInfrastructureError,
} from "../retrieval/infrastructure-error.js";
import { assertSearchProviderReady } from "../retrieval/search-providers.js";
import { startCpuProfiler, type CpuProfiler } from "../tracing/cpu-profile.js";
import {
  TraceArchive,
  serializeError,
  sha256Json,
} from "../tracing/trace-archive.js";
import {
  ArmCircuitBreakers,
  shouldPauseRetrievalArm,
} from "./arm-circuit-breaker.js";
import { notifyRegisteredStart } from "./registered-run-lifecycle.js";
import { ExperimentRegistry, type RegistryRunStatus } from "./registry.js";

import { readForecastArms, readForecastOptions } from "./forecast/options.js";
import { applyEnvironmentDefaults } from "./params/resolve.js";
import {
  loadForecastQuestions,
  loadProvidedEvidence,
} from "./forecast/questions.js";
import {
  reportForecastQuality,
  reportForecastResources,
} from "./forecast/report.js";
import {
  buildResourceRows,
  createResourceCounters,
  snapshotPipelineResources,
} from "./forecast/resources.js";
import { createForecastRetrieval } from "./forecast/retrieval.js";

import { buildForecastRunConfig } from "./forecast/run-config.js";
import { projectEnv } from "../env-names.js";

let activeArchive: TraceArchive | undefined;
let activeRegistry:
  | {
      registry: ExperimentRegistry;
      runId: string;
      heartbeat: ReturnType<typeof setInterval>;
      finished: boolean;
    }
  | undefined;

function finishActiveRegistry(
  status: Exclude<RegistryRunStatus, "claimed" | "running" | "sleeping">,
  error?: string,
): void {
  if (!activeRegistry || activeRegistry.finished) return;
  activeRegistry.finished = true;
  clearInterval(activeRegistry.heartbeat);
  try {
    activeRegistry.registry.finishRun(activeRegistry.runId, status, error);
  } finally {
    activeRegistry.registry.close();
    activeRegistry = undefined;
  }
}

// Set FABENCH_CPU_PROFILE_DIR to sample this process's main thread (see src/tracing/cpu-profile.ts).
let activeCpuProfiler: CpuProfiler | undefined;
const cpuProfileDir = projectEnv("FABENCH_CPU_PROFILE_DIR");
if (cpuProfileDir) {
  activeCpuProfiler = startCpuProfiler(cpuProfileDir);
  console.error(
    `[INFO] CPU profile segments -> ${cpuProfileDir}`,
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    try {
      activeArchive?.finish("interrupted", { signal });
    } finally {
      finishActiveRegistry("interrupted", signal);
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
  });
}

/** Run `tasks` with at most `limit` in flight, preserving result order. */
async function pool<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= tasks.length) return;
        out[i] = await tasks[i]!();
      }
    }),
  );
  return out;
}

async function main() {
  const options = readForecastOptions();
  for (const warning of options.parameters.warnings) console.warn(`    ⚠️  ${warning}`);
  applyEnvironmentDefaults(options.parameters);
  const { conc, iters, maxToolCalls, quality, llm, effort, ledger } = options;
  // The packet for the `provided` arm: {question_id -> evidence text}. Loaded once and hashed
  // into the run card, so a result can be traced back to the exact packet that produced it.
  const evidenceFile = options.evidenceFile;
  const evidence = loadProvidedEvidence(evidenceFile);
  const { providedEvidence, evidenceSha, evidenceQuestionCount } = evidence;
  const li = llm.indexOf(":");
  const client = limitModelConcurrency(
    createLlmClient(
      li >= 0 ? llm.slice(0, li) : llm,
      li >= 0 ? llm.slice(li + 1) : undefined,
    ),
    options.modelConcurrency,
  );
  const dataset = loadForecastQuestions(options);
  const { questions, topics } = dataset;

  const arms = readForecastArms(options);
  const { columns, parsed, webFilterColumns } = arms;
  const armCircuits = new ArmCircuitBreakers(webFilterColumns);
  let providerCircuitError: ProviderApiError | undefined;

  const retrieval = createForecastRetrieval({
    options,
    arms,
    client,
    questions,
    evidenceFile,
    providedEvidence,
  });
  const {
    leakFilter,
    dater,
    qualityRuntime,
    backends,
    liveSearchProviders,
    agenticFactories,
  } = retrieval;

  const spread: Record<string, number> = {};
  for (const q of questions) {
    const t = topics[q.question_id]?.topic ?? "unknown";
    spread[t] = (spread[t] ?? 0) + 1;
  }
  console.log(
    `=== forecast value · ${questions.length} questions · conc=${conc} · effort=${effort || "(default)"} ===`,
  );
  console.log(
    `    topics: ${Object.entries(spread)
      .map(([t, c]) => `${t}=${c}`)
      .join(", ")}`,
  );
  // Print all requested arms in the run banner.
  for (const spec of columns) {
    const { source: world, expand } = parsed.get(spec)!;
    if (world === "none") {
      console.log(`    ${spec.padEnd(16)} closed book (no retrieval)`);
      continue;
    }
    if (world === "provided") {
      // Its own line, because the fall-through below describes every arm as driving its own
      // search — which this one does not do at all, and printing that on the run card would
      // misdescribe the arm to whoever reads it later.
      console.log(
        `    ${spec.padEnd(20)} closed book plus a fixed evidence packet, no searching ` +
          `(${evidenceQuestionCount} questions, sha ${evidenceSha.slice(0, 12)})`,
      );
      continue;
    }
    const label = (b: string) =>
      b === "frozen"
        ? "the frozen index"
        : b === "web-filter"
          ? "filtered live web"
          : `BackSearch (mode=${options.backsearchMode}, ` +
            `corpus=${options.backsearchCorpus})`;
    // Named in merge order, because order is priority: the first branch keeps all its
    // results and the rest fill only its gaps.
    const desc = parsed.get(spec)!.branches.map(label).join(" + ");
    console.log(
      `    ${spec.padEnd(20)} model drives its own web_search/web_fetch over ${desc}` +
        (expand ? ", each query searched several ways" : ""),
    );
  }
  console.log();

  const { tag, codeIdentity, conditions, conditionsByArm, runConfig } =
    buildForecastRunConfig({
      options,
      arms,
      retrieval,
      dataset,
      evidence,
      evidenceFile,
      client,
    });

  const conditionPreviewFile = options.conditionPreviewFile;
  if (conditionPreviewFile) {
    const output = resolve(conditionPreviewFile);
    writeFileSync(
      output,
      `${JSON.stringify(
        {
          schema_version: "raven.condition-preview.v1",
          generated_at_utc: new Date().toISOString(),
          code_identity: codeIdentity,
          parameters: runConfig.parameters,
          page_dater: dater.configuration(),
          conditions,
        },
        null,
        2,
      )}\n`,
    );
    retrieval.close();
    console.log(`    condition preview → ${output}`);
    return;
  }
  const registryEnabled = options.registryEnabled;
  const replicate = options.replicate;
  const replicateReason = options.replicateReason;
  if (replicate && !replicateReason)
    throw new Error(`--replicate 1 requires --replicate-reason`);
  const requestedRegistryCells = columns.flatMap((arm) => {
    const conditionId = conditionsByArm.get(arm)!.condition_id;
    return questions.map((question) => ({
      conditionId,
      questionId: question.question_id,
      arm,
    }));
  });
  const experimentKey = sha256Json({
    schema: "raven.experiment-key.v1",
    conditions: conditions.map((condition) => condition.condition_id).sort(),
    questions: questions.map((question) => question.question_id).sort(),
  });
  const registry = registryEnabled
    ? new ExperimentRegistry(options.registryPath)
    : null;
  if (!registryEnabled)
    console.warn(
      `    ⚠️  registry explicitly disabled: this run cannot prevent duplicate billing and is invisible to other users`,
    );
  const preflight = registry?.prepareRun({
    experimentKey,
    tag,
    expectedCells: requestedRegistryCells.length,
    config: runConfig,
    cells: requestedRegistryCells,
    replicate,
    replicateReason: replicateReason || undefined,
  }) ?? {
    runId: undefined,
    claimed: requestedRegistryCells,
    reused: [],
    blocked: [],
  };
  if (preflight.blocked.length) {
    const owners = new Map<string, (typeof preflight.blocked)[number]>();
    for (const cell of preflight.blocked)
      owners.set(`${cell.owner}\0${cell.runId}`, cell);
    console.error(
      `\n❌ ${preflight.blocked.length} cells are being run by other experiments; no model was called in this run:`,
    );
    for (const cell of owners.values())
      console.error(
        `    ${cell.owner} · ${cell.tag} · run=${cell.runId} · lease=${cell.leaseExpiresUtc}`,
      );
    registry?.close();
    retrieval.close();
    process.exitCode = 3;
    return;
  }
  const registryRunId = preflight.runId ?? randomUUID();
  process.env.FABENCH_ACTIVE_RUN_ID = registryRunId;
  runConfig.registry = registry
    ? {
        path: registry.path,
        run_id: registryRunId,
        experiment_key: experimentKey,
        claimed_cells: preflight.claimed.length,
        reused_cells: preflight.reused.length,
      }
    : null;
  console.log(
    `    registry: ${registry?.path ?? "off"} · new=${preflight.claimed.length} · reused=${preflight.reused.length}`,
  );

  mkdirSync(RESULTS_DIR, { recursive: true });
  const traceArchive = new TraceArchive({
    runId: registryRunId,
    resultsDir: RESULTS_DIR,
    tag,
    expectedCells: preflight.claimed.length,
    run: runConfig,
  });
  activeArchive = traceArchive;
  if (registry) {
    registry.markRunning(registryRunId, traceArchive.directory);
    const heartbeat = setInterval(() => {
      try {
        registry.heartbeat(registryRunId);
      } catch (error) {
        console.error(
          `registry heartbeat failed; aborting to avoid duplicate work:`,
          error,
        );
        process.kill(process.pid, "SIGTERM");
      }
    }, 30_000);
    heartbeat.unref();
    activeRegistry = {
      registry,
      runId: registryRunId,
      heartbeat,
      finished: false,
    };
  }

  if (projectEnv("FABENCH_SHARED_LIFECYCLE") === "1") {
    if (!registry)
      throw new Error("Shared experiments require the central registry");
    await notifyRegisteredStart(registry, registryRunId);
  }

  const openWebFilterCircuit = (error: RetrievalInfrastructureError): void => {
    const opened = armCircuits.openWebFilter(error);
    if (!opened.length) return;
    console.error(
      `\n⏸️  Web-filter paused automatically: ${error.component}/${error.code} · ${error.message}`,
    );
    console.error(
      `    Stopped claiming/calling ${opened.join(", ")}; other arms continue, and Web cells not yet run are marked interrupted.`,
    );
  };

  // Exercise the actual persistent helper before paying for any claimed Web forecast. The
  // run and trace already exist at this point, so a failed preflight is visible to every user
  // in the shared registry rather than disappearing as a shell error.
  const claimedWebCells = preflight.claimed.filter((cell) =>
    webFilterColumns.includes(cell.arm),
  ).length;
  if (claimedWebCells > 0) {
    try {
      for (const provider of liveSearchProviders.values()) {
        try {
          await assertSearchProviderReady(provider, (receipt) =>
            writeFileSync(
              join(
                traceArchive.directory,
                `search-preflight-${provider.name}.json`,
              ),
              JSON.stringify(receipt, null, 2) + "\n",
            ),
          );
        } catch (error) {
          throw new RetrievalInfrastructureError(
            "search-provider",
            "preflight_failed",
            `${provider.name} readiness failed before forecast calls`,
            { cause: error },
          );
        }
      }
      await dater.assertReady();
      const ready = dater.snapshot();
      console.log(
        `    web-filter preflight: page-dater ready · Jina=${ready.readerEnabled ? `live-read ${ready.readerPreflightPassed ? "passed" : "failed"}` : "disabled"}`,
      );
    } catch (error) {
      openWebFilterCircuit(
        isRetrievalInfrastructureError(error)
          ? error
          : new RetrievalInfrastructureError(
              "page-dater",
              "preflight_failed",
              `page-dater health check failed`,
              { cause: error },
            ),
      );
    }
  }

  const outcomes = questions.map((q) => q.ground_truth as 0 | 1);
  // Failed cells stay null and are EXCLUDED from every score below — never defaulted to 0.5.
  // Per-arm metrics use that arm's successful cells; paired metrics use cells where both the
  // arm and the baseline succeeded. The failRate>0.05 abort still refuses to report a broken run.
  const forecasts: Record<string, (number | null)[]> = {};
  for (const label of columns)
    forecasts[label] = new Array(questions.length).fill(null);
  const questionIndex = new Map(
    questions.map((question, index) => [question.question_id, index]),
  );
  const registryCellKey = (conditionId: string, questionId: string) =>
    `${conditionId}\0${questionId}`;
  const reusedByCell = new Map(
    preflight.reused.map((cell) => [
      registryCellKey(cell.conditionId, cell.questionId),
      cell,
    ]),
  );
  // Tokens and wall-clock are part of the result, not trivia: two arms with equal Brier and
  // 10x different spend are not equal, and ranking models needs the bill next to the score.
  const resources = createResourceCounters(columns);
  for (const cell of preflight.reused) {
    const index = questionIndex.get(cell.questionId);
    if (index == null) continue;
    forecasts[cell.arm]![index] = cell.probability;
    resources.get(cell.arm)!.reused++;
  }
  const failures: string[] = [];
  // Successful cells whose answer needed an ignored extra field or surrounding text removed.
  const formatRepaired: {
    arm: string;
    question_id: string;
    repairs: string[];
  }[] = [];
  let llmCost = 0;
  let done = 0;
  const t0 = Date.now();
  await pool(
    questions.map((q, qi) => async () => {
      // Arms run CONCURRENTLY within a question. They are independent by construction — same
      // question, same anchor, different evidence source — so serialising them bought nothing
      // and cost a great deal: with `conc` questions in flight and one arm at a time, only
      // `conc` model calls were ever outstanding, so a five-arm run used a fifth of the
      // concurrency it appeared to.
      await Promise.all(
        columns.map(async (label) => {
          const conditionId = conditionsByArm.get(label)!.condition_id;
          const reused = reusedByCell.get(
            registryCellKey(conditionId, q.question_id),
          );
          if (reused) return;
          if (providerCircuitError) {
            resources.get(label)!.interrupted++;
            registry?.recordCell(registryRunId, {
              conditionId,
              questionId: q.question_id,
              arm: label,
              status: "interrupted",
              summary: {
                reason: "forecaster_provider_circuit_open",
                provider: providerCircuitError.providerId,
                category: providerCircuitError.category,
                status: providerCircuitError.status,
                provider_code: providerCircuitError.providerCode,
              },
            });
            return;
          }
          if (armCircuits.isOpen(label)) {
            armCircuits.noteSkipped(label);
            resources.get(label)!.interrupted++;
            registry?.recordCell(registryRunId, {
              conditionId,
              questionId: q.question_id,
              arm: label,
              status: "interrupted",
              summary: {
                reason: "web_filter_circuit_open",
                circuit: armCircuits
                  .snapshots()
                  .find((state) => state.arm === label),
              },
            });
            return;
          }
          registry?.markCellRunning(registryRunId, conditionId, q.question_id);
          const cellT0 = Date.now();
          const recorder = traceArchive.beginCell({
            question_id: q.question_id,
            arm: label,
            condition: conditionsByArm.get(label),
            question: q.question_text,
            as_of: q.as_of_date ?? q.resolution_date,
            resolution_criteria: q.resolution_criteria,
          });
          const make = agenticFactories.get(label);
          const own = make
            ? make(recorder, q)
            : new AgenticSearchPredictor(client, undefined, {
                maxToolCalls: 0,
                effort: effort || undefined,
                // The closed-book arm gets the ledger too, or the A/B would compare a ledger
                // retrieval arm against a non-ledger baseline and attribute the format change
                // to retrieval.
                ledger,
                trace: recorder,
              });
          let p: Awaited<ReturnType<AgenticSearchPredictor["predict"]>>;
          try {
            p = await own.predict(q, NullRetrievalEnv, BudgetTier.Unlimited);
          } catch (error) {
            // Ordinary page-review failures stay local. An incompatible provider protocol
            // requires an explicit experiment-policy decision and pauses the affected arm.
            if (
              isRetrievalInfrastructureError(error) &&
              shouldPauseRetrievalArm(error)
            )
              openWebFilterCircuit(error);
            if (
              isNonRetryableProviderApiError(error) &&
              (error.category === "insufficient_balance" ||
                error.category === "authentication" ||
                error.category === "reasoning_replay_required") &&
              !providerCircuitError
            ) {
              providerCircuitError = error;
              console.error(
                `\n⏸️  Forecaster provider paused automatically: ${error.providerId}/${error.category} ` +
                  `(HTTP ${error.status}${error.providerCode ? `, code=${error.providerCode}` : ""})`,
              );
              console.error(
                `    Balance, authentication or a reasoning-replay requirement needs attention; the experiment rules are not changed automatically and successful cells are kept.`,
              );
            }
            // Unlike the old success-only transcript, a failed cell is itself a first-class
            // archive row and points at the durable partial event stream.
            const durationMs = Date.now() - cellT0;
            const resource = resources.get(label)!;
            const maxCalls =
              conditionsByArm.get(label)?.max_tool_calls ?? maxToolCalls;
            const executedToolCalls = own.lastTrace.filter(
              (call) => call.outcome !== "budget exhausted; not executed",
            ).length;
            const skippedToolCalls = own.lastTrace.length - executedToolCalls;
            resource.failed++;
            resource.failedCost += own.lastUsage.costUsd;
            resource.budgetReachedOnFailed +=
              maxCalls > 0 && executedToolCalls >= maxCalls ? 1 : 0;
            resource.overBudgetRequestedOnFailed +=
              skippedToolCalls > 0 ? 1 : 0;
            llmCost += own.lastUsage.costUsd;
            failures.push(
              `${label} @ ${q.question_id}: ${String((error as Error)?.message).slice(0, 80)}`,
            );
            recorder.finish("failed", {
              question_id: q.question_id,
              question: q.question_text,
              as_of: q.as_of_date ?? q.resolution_date,
              arm: label,
              status: "failed",
              probability: null,
              ground_truth: q.ground_truth,
              reasoning_turns: own.lastTurns,
              final_answer: "",
              tool_calls: own.lastTrace,
              max_tool_calls: maxCalls,
              executed_tool_calls: executedToolCalls,
              skipped_tool_calls_budget_exhausted: skippedToolCalls,
              tool_call_budget_reached:
                maxCalls > 0 && executedToolCalls >= maxCalls,
              sources_read: [],
              cost_usd: own.lastUsage.costUsd,
              input_tokens: own.lastUsage.inputTokens,
              output_tokens: own.lastUsage.outputTokens,
              reasoning_tokens: own.lastUsage.reasoningTokens,
              model_ms: own.lastUsage.modelMs,
              tool_ms: own.lastUsage.toolMs,
              duration_ms: durationMs,
              predictor_id: own.id,
              error: serializeError(error),
            });
            registry?.recordCell(registryRunId, {
              conditionId,
              questionId: q.question_id,
              arm: label,
              status: "failed",
              tracePath: recorder.path,
              summary: {
                error: serializeError(error).message,
                cost_usd: own.lastUsage.costUsd,
                duration_ms: durationMs,
              },
            });
            return;
          }

          // Wall-clock of THIS cell, retries and tool calls included. Cells run concurrently,
          // so these sum to more than the run took; it is per-question latency, not run time.
          const durationMs = Date.now() - cellT0;
          const transcriptRow = {
            question_id: q.question_id,
            question: q.question_text,
            as_of: q.as_of_date ?? q.resolution_date,
            arm: label,
            status: "success",
            probability: p.probabilities[0] ?? null,
            ...(q.response_format
              ? {
                  numeric_forecast: p.numeric_forecast,
                  format_repairs: p.format_repairs ?? [],
                  prediction_cutoff_utc: q.prediction_cutoff_utc,
                }
              : {}),
            ground_truth: q.ground_truth,
            reasoning_turns: own.lastTurns,
            final_answer:
              p.rationale_md.split("--- final answer ---")[1]?.trim() ?? "",
            tool_calls: own.lastTrace,
            max_tool_calls:
              conditionsByArm.get(label)?.max_tool_calls ?? maxToolCalls,
            sources_read: p.sources,
            cost_usd: p.cost_usd,
            input_tokens: p.input_tokens ?? null,
            output_tokens: p.output_tokens ?? null,
            reasoning_tokens: own.lastUsage.reasoningTokens,
            model_ms: own.lastUsage.modelMs,
            tool_ms: own.lastUsage.toolMs,
            duration_ms: durationMs,
            predictor_id: p.predictor_id,
          };
          forecasts[label]![qi] = p.probabilities[0] ?? null;
          llmCost += p.cost_usd ?? 0;
          const r = resources.get(label)!;
          r.cells++;
          r.cost += p.cost_usd ?? 0;
          r.inTok += p.input_tokens ?? 0;
          r.outTok += p.output_tokens ?? 0;
          r.reasoningTok += own.lastUsage.reasoningTokens;
          r.ms += durationMs;
          r.modelMs += own.lastUsage.modelMs;
          r.toolMs += own.lastUsage.toolMs;
          const executedTrace = own.lastTrace.filter(
            (call) => call.outcome !== "budget exhausted; not executed",
          );
          const skippedToolCalls = own.lastTrace.length - executedTrace.length;
          const maxCalls =
            conditionsByArm.get(label)?.max_tool_calls ?? maxToolCalls;
          Object.assign(transcriptRow, {
            executed_tool_calls: executedTrace.length,
            skipped_tool_calls_budget_exhausted: skippedToolCalls,
            tool_call_budget_reached:
              maxCalls > 0 && executedTrace.length >= maxCalls,
          });
          r.budgetReached +=
            maxCalls > 0 && executedTrace.length >= maxCalls ? 1 : 0;
          r.overBudgetRequested += skippedToolCalls > 0 ? 1 : 0;
          if (p.format_repairs?.length)
            formatRepaired.push({
              arm: label,
              question_id: q.question_id,
              repairs: p.format_repairs,
            });
          recorder.finish("success", transcriptRow);
          registry?.recordCell(registryRunId, {
            conditionId,
            questionId: q.question_id,
            arm: label,
            status: "success",
            probability: p.probabilities[0] ?? null,
            tracePath: recorder.path,
            summary: {
              cost_usd: p.cost_usd,
              input_tokens: p.input_tokens ?? null,
              output_tokens: p.output_tokens ?? null,
              duration_ms: durationMs,
              predictor_id: p.predictor_id,
            },
          });
          r.toolCalls += executedTrace.length;
          const searchedUrls = new Set<string>();
          const fetchedUrls = new Set<string>();
          for (const call of executedTrace) {
            if (call.name === "web_search") {
              r.searchCalls++;
              const results = call.results ?? [];
              r.searchResultUrls += results.length;
              for (const result of results) {
                searchedUrls.add(result.url);
                r.searchSnippetChars += result.snippet.length;
              }
            } else if (call.name === "web_fetch") {
              r.fetchCalls++;
              if (call.fetched) {
                r.fetchedDocuments++;
                fetchedUrls.add(call.fetched.url);
                r.fetchedDocumentChars += call.fetched.chars;
              }
            }
          }
          r.uniqueSearchUrls += searchedUrls.size;
          r.uniqueFetchedUrls += fetchedUrls.size;
        }),
      );
      done++;
      process.stdout.write(
        `\r  ${done}/${questions.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s  $${llmCost.toFixed(2)}   `,
      );
    }),
    conc,
  );
  process.stdout.write("\n");
  const circuitBreakers = armCircuits.snapshots();
  // A later infrastructure outage does not retroactively corrupt cells that completed with
  // the promised treatment. Preserve them for the next completion run instead of paying for
  // the same successful forecasts again.
  const preservedCanonicalCells = Object.fromEntries(
    circuitBreakers.map((state) => [
      state.arm,
      resources.get(state.arm)?.cells ?? 0,
    ]),
  );
  const pipelineResources = snapshotPipelineResources({
    retrieval,
    client,
    conditions,
    quality,
    llmCost,
    readerEnabled: options.readerEnabled,
  });
  const resourceRows = buildResourceRows({
    columns,
    resources,
    conditionsByArm,
    maxToolCalls,
    client,
  });
  retrieval.close();
  const resourceMetricsFile = projectEnv("FABENCH_RESOURCE_METRICS_FILE");
  if (resourceMetricsFile) {
    writeFileSync(resourceMetricsFile, JSON.stringify({
      unit: "question_arm",
      completed_units: resourceRows.reduce((sum, row) => sum + row.cells, 0),
      failed_units: resourceRows.reduce((sum, row) => sum + row.failed + row.interrupted, 0),
      reused_units: resourceRows.reduce((sum, row) => sum + row.reused, 0),
    }, null, 2) + "\n");
  }

  // Refuse to report past a failure threshold rather than let a broken run look like a finding:
  // one run had 123 of 200 cells fail and (when failures were filled with 0.5) still printed a
  // full table showing every arm losing to closed book. Below the threshold, failed cells are
  // excluded from scoring rather than filled.
  const cells = questions.length * columns.length;
  const failRate = failures.length / Math.max(1, cells);
  if (providerCircuitError) {
    const interrupted = resourceRows.reduce(
      (sum, row) => sum + row.interrupted,
      0,
    );
    const providerFailure = {
      provider: providerCircuitError.providerId,
      category: providerCircuitError.category,
      status: providerCircuitError.status,
      provider_code: providerCircuitError.providerCode,
      message: providerCircuitError.message,
    };
    console.error(
      `\n⏸️  Forecaster provider paused; skipped ${interrupted} cells not yet run; no result table for this run.`,
    );
    writeFileSync(
      join(RESULTS_DIR, `forecast-value-${tag}-FAILED.json`),
      JSON.stringify(
        {
          config: runConfig,
          reason: "forecaster_provider_circuit_breaker",
          provider_failure: providerFailure,
          failures,
          cells,
          resources: resourceRows,
          pipeline_resources: pipelineResources,
          trace_archive: relative(RESULTS_DIR, traceArchive.directory),
          trace_run_id: traceArchive.runId,
        },
        null,
        2,
      ),
    );
    traceArchive.finish("failed", {
      format_repaired: formatRepaired,
      reason: "forecaster_provider_circuit_breaker",
      provider_failure: providerFailure,
      failures: failures.length,
      cells,
      resources: resourceRows,
      pipeline_resources: pipelineResources,
    });
    activeArchive = undefined;
    finishActiveRegistry("failed", "forecaster_provider_circuit_breaker");
    console.error(`Full trace → ${traceArchive.directory}`);
    process.exitCode = 1;
    return;
  }
  if (circuitBreakers.length) {
    const interrupted = resourceRows.reduce(
      (sum, row) => sum + row.interrupted,
      0,
    );
    console.error(
      `\n⏸️  ${circuitBreakers.map((state) => state.arm).join(", ")} paused by the retrieval circuit breaker; ` +
        `skipped ${interrupted} cells not yet run; no result table for this run.`,
    );
    writeFileSync(
      join(RESULTS_DIR, `forecast-value-${tag}-FAILED.json`),
      JSON.stringify(
        {
          config: runConfig,
          reason: "web_filter_circuit_breaker",
          circuit_breakers: circuitBreakers,
          preserved_canonical_cells: preservedCanonicalCells,
          failures,
          cells,
          resources: resourceRows,
          pipeline_resources: pipelineResources,
          trace_archive: relative(RESULTS_DIR, traceArchive.directory),
          trace_run_id: traceArchive.runId,
        },
        null,
        2,
      ),
    );
    traceArchive.finish("failed", {
      format_repaired: formatRepaired,
      reason: "web_filter_circuit_breaker",
      circuit_breakers: circuitBreakers,
      preserved_canonical_cells: preservedCanonicalCells,
      failures: failures.length,
      cells,
      resources: resourceRows,
      pipeline_resources: pipelineResources,
    });
    activeArchive = undefined;
    finishActiveRegistry("failed", "web_filter_circuit_breaker");
    console.error(`Full trace → ${traceArchive.directory}`);
    process.exitCode = 1;
    return;
  }
  if (formatRepaired.length)
    console.log(
      `\n    Format repaired in ${formatRepaired.length}/${cells} cells: only extra fields or text outside the answer were ignored; probabilities and values unchanged (${FORECAST_PARSE_POLICY})`,
    );
  if (failRate > 0.05) {
    console.error(
      `\n❌ ${failures.length}/${cells} calls failed (${(failRate * 100).toFixed(0)}%) — results unusable; no result table.`,
    );
    for (const f of failures.slice(0, 5)) console.error(`     ${f}`);
    writeFileSync(
      join(RESULTS_DIR, `forecast-value-${tag}-FAILED.json`),
      JSON.stringify(
        {
          config: runConfig,
          failures,
          circuit_breakers: circuitBreakers,
          cells,
          resources: resourceRows,
          pipeline_resources: pipelineResources,
          trace_archive: relative(RESULTS_DIR, traceArchive.directory),
          trace_run_id: traceArchive.runId,
        },
        null,
        2,
      ),
    );
    traceArchive.finish("failed", {
      format_repaired: formatRepaired,
      reason: "failure_rate_exceeded",
      failures: failures.length,
      cells,
      failure_rate: failRate,
      resources: resourceRows,
      pipeline_resources: pipelineResources,
    });
    activeArchive = undefined;
    finishActiveRegistry("failed", "failure_rate_exceeded");
    console.error(`Full trace → ${traceArchive.directory}`);
    process.exitCode = 1;
    return;
  }
  if (failures.length)
    console.log(
      `\n⚠️  ${failures.length}/${cells} calls failed (${(failRate * 100).toFixed(1)}%); these cells are excluded from scoring (not filled with 0.5)`,
    );

  const { baseline, rows, pairs, byTopic } = reportForecastQuality({
    columns,
    forecasts,
    outcomes,
    questions,
    topics,
    iters,
  });

  reportForecastResources(resourceRows);
  console.log(
    `\nFull trace → ${traceArchive.directory}\n` +
      `  manifest.json · cells.jsonl · cells/<question×arm>.jsonl\n` +
      `  Full prompt/response/reasoning · every model and HTTP attempt · full tool input/output · failure traces`,
  );

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(
    join(RESULTS_DIR, `forecast-value-${tag}.json`),
    JSON.stringify(
      {
        n: questions.length,
        baseline,
        // Keep the run configuration beside its scores.
        config: runConfig,
        trace_archive: relative(RESULTS_DIR, traceArchive.directory),
        trace_run_id: traceArchive.runId,
        registry: runConfig.registry,
        rows,
        // Per-arm means over successful cells: tokens, tool calls, latency, cost. The
        // leaderboard reads these, and old result files simply lack the field.
        resources: resourceRows,
        pipeline_resources: pipelineResources,
        circuit_breakers: circuitBreakers,
        costs: pipelineResources.costs,
        pairs,
        byTopic,
        failures,
        llmCost,
        perQuestion: questions.map((q, i) => ({
          question_id: q.question_id,
          question: q.question_text,
          as_of: q.as_of_date ?? q.resolution_date,
          topic: topics[q.question_id]?.topic ?? "unknown",
          outcome: outcomes[i],
          forecasts: Object.fromEntries(
            columns.map((label) => [label, forecasts[label]![i]]),
          ),
        })),
      },
      null,
      2,
    ),
  );

  // Per-stage counters, because an aggregate has no standing to prove the work happened: one
  // live arm returned 0 results on 1,524 of 1,531 searches while its Brier score printed
  // clean and "significant".
  for (const [world, b] of backends)
    console.log(`Backend ${world}: ${JSON.stringify(b.stats())}`);
  const d = dater.snapshot();
  if (d.requested) {
    console.log(
      `Page fetches: requested ${d.requested} · dated ${d.fetched} (recovered by reader ${d.viaReader})` +
        ` · blocked ${d.blocked} (reader throttled ${d.readerThrottled}) · undated ${d.undated}`,
    );
    for (const [why, n] of Object.entries(d.whyCounts ?? {}))
      console.log(`    ${String(n).padStart(5)}  ${why}`);
  }
  if (qualityRuntime?.cleaner)
    console.log("Reader cleaning:", qualityRuntime.cleaner.snapshot());
  if (qualityRuntime?.reviewer) {
    const s = qualityRuntime.reviewer.snapshot();
    console.log(
      `evidence reviewer: ${s.modelCalls} model calls, ${s.searchCalls} searches, ${s.readCalls} reads, reported model cost $${s.costUsd.toFixed(4)}`,
    );
  }
  if (leakFilter) {
    const s = leakFilter.snapshot();
    console.log(
      `Leak review: scanned ${s.scanned} · reviewed ${s.reviewed} ` +
        `(${((s.reviewed / Math.max(1, s.scanned)) * 100).toFixed(1)}%) · dropped ${s.dropped}` +
        ` · failed ${s.reviewFailed} · cache hit ${s.cacheHits}` +
        ` · fallback ${s.fallbackSucceeded}/${s.fallbackUsed} succeeded` +
        ` · peak concurrency ${s.peakReviewConcurrency} · cost $${s.costUsd.toFixed(3)}`,
    );
  }
  const costs = pipelineResources.costs;
  console.log(
    `cost: forecaster ${costs.forecaster_llm_usd == null ? "unpriced" : `$${costs.forecaster_llm_usd.toFixed(3)}`} ` +
      `· filter ${costs.leak_filter_llm_usd == null ? "unpriced" : `$${costs.leak_filter_llm_usd.toFixed(3)}`} ` +
      `· expansion ${costs.query_expansion_llm_usd == null ? "unpriced" : `$${costs.query_expansion_llm_usd.toFixed(3)}`} ` +
      `· known total $${costs.known_total_usd.toFixed(3)}` +
      (costs.complete
        ? ""
        : ` · incomplete: ${costs.unpriced_components.join(", ")}`) +
      ` · wall-clock ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
  traceArchive.finish("completed", {
    format_repaired: formatRepaired,
    questions: questions.length,
    cells,
    failures: failures.length,
    circuit_breakers: circuitBreakers,
    costs,
    pipeline_resources: pipelineResources,
    duration_ms: Date.now() - t0,
  });
  activeArchive = undefined;
  finishActiveRegistry("completed");
}

// main() has several early returns (provider pause, circuit breakers, blocked cells), so the
// last profile segment is written here, after any of them.
function stopCpuProfiler(): void {
  activeCpuProfiler
    ?.stop()
    .catch((profileError) =>
      console.error("CPU profile close failed:", profileError),
    );
}

main().then(stopCpuProfiler, (error) => {
  try {
    activeArchive?.finish("failed", { error: serializeError(error) });
  } catch (archiveError) {
    console.error("trace archive close also failed:", archiveError);
  }
  activeArchive = undefined;
  try {
    finishActiveRegistry("failed", serializeError(error).message);
  } catch (registryError) {
    console.error("registry close also failed:", registryError);
  }
  console.error(error);
  process.exitCode = 1;
  stopCpuProfiler();
});
