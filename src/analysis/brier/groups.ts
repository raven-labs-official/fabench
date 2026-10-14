import { classifyResultScope } from "../result-scope.js";
import { parseRegistryObject } from "../../experiments/registry-json.js";

import {
  type CanonicalCell,
  type ConditionConfig,
  type FailedCellCount,
  type GroupDraft,
  type Policy,
  type RegistryData,
  type RegistryRun,
  type RunConfig,
} from "./records.js";

function conditionFor(
  config: RunConfig,
  conditionId: string,
  arm: string,
): ConditionConfig {
  return (
    config.conditions?.find(
      (condition) => condition.condition_id === conditionId,
    ) ?? {
      condition_id: conditionId,
      arm,
      question_set_id: config.question_set_id,
      model: config.llm,
      search_type: arm,
    }
  );
}

function relevantRun(config: RunConfig): boolean {
  return (
    config.dataset === "beta-raven-bench/selected_300" ||
    config.question_set_id?.startsWith("beta-raven-pm-202603-selected300@") ===
      true
  );
}

function representativeRun(
  rows: readonly { run: RegistryRun; config: RunConfig }[],
) {
  return [...rows].sort((a, b) => {
    const aN = a.config.selected_question_ids?.length ?? 0;
    const bN = b.config.selected_question_ids?.length ?? 0;
    if (aN !== bN) return bN - aN;
    return b.run.started_at_utc.localeCompare(a.run.started_at_utc);
  })[0]!;
}

/** Group canonical cells by condition and select the current publishable conditions. */
export function buildConditionGroups(
  registry: RegistryData,
  policy: Policy,
): GroupDraft[] {
  const { runs } = registry;
  const runConfigs = new Map<string, RunConfig>();
  for (const run of runs)
    runConfigs.set(
      run.run_id,
      parseRegistryObject<RunConfig>(run.config_json, `${run.run_id} config_json`),
    );
  const selectedRuns = runs.filter((run) =>
    relevantRun(runConfigs.get(run.run_id)!),
  );
  const selectedRunIds = new Set(selectedRuns.map((run) => run.run_id));
  const canonicalCells = registry.canonicalCells.filter((cell) =>
    selectedRunIds.has(cell.source_run_id),
  );
  const statusRows = registry.statusRows.filter((row) =>
    selectedRunIds.has(row.run_id),
  );

  const runIdsByCondition = new Map<string, Set<string>>();
  for (const row of statusRows) {
    const ids = runIdsByCondition.get(row.condition_id) ?? new Set<string>();
    ids.add(row.run_id);
    runIdsByCondition.set(row.condition_id, ids);
  }
  for (const cell of canonicalCells) {
    const ids = runIdsByCondition.get(cell.condition_id) ?? new Set<string>();
    ids.add(cell.source_run_id);
    runIdsByCondition.set(cell.condition_id, ids);
  }

  const failureCounts = new Map<string, FailedCellCount>();
  for (const row of statusRows) {
    const counts = failureCounts.get(row.condition_id) ?? {
      condition_id: row.condition_id,
      failed: 0,
      interrupted: 0,
      running: 0,
      claimed: 0,
    };
    if (row.status === "failed") counts.failed += 1;
    else if (row.status === "interrupted") counts.interrupted += 1;
    else if (row.status === "running") counts.running += 1;
    else if (row.status === "claimed") counts.claimed += 1;
    failureCounts.set(row.condition_id, counts);
  }

  const cellsByCondition = new Map<string, CanonicalCell[]>();
  for (const cell of canonicalCells) {
    const list = cellsByCondition.get(cell.condition_id) ?? [];
    list.push(cell);
    cellsByCondition.set(cell.condition_id, list);
  }

  const groups: GroupDraft[] = [];
  for (const [conditionId, runIds] of runIdsByCondition.entries()) {
    const linkedRuns = [...runIds]
      .map((runId) => runs.find((run) => run.run_id === runId))
      .filter((run): run is RegistryRun => Boolean(run))
      .map((run) => ({ run, config: runConfigs.get(run.run_id)! }))
      .filter((row) => relevantRun(row.config));
    if (!linkedRuns.length) continue;
    const representative = representativeRun(linkedRuns);
    const cells = cellsByCondition.get(conditionId) ?? [];
    // Legacy registrations without a completed canonical cell are useful to the run registry,
    // but they are not answer-table groups and would otherwise surface as model/mode=unknown.
    if (!cells.length) continue;
    const arm = cells[0]!.arm;
    const condition = conditionFor(
      representative.config,
      conditionId,
      arm,
    );
    const expectedIds = representative.config.selected_question_ids ?? [];
    const expectedQuestions = Math.max(expectedIds.length, cells.length);
    const resultScope = classifyResultScope(
      expectedQuestions,
      policy.minimum_expected_questions,
    );
    const model =
      condition.model ?? representative.config.llm ?? "unknown:unknown";
    const separator = model.indexOf(":");
    const provider = separator >= 0 ? model.slice(0, separator) : "unknown";
    const modelName = separator >= 0 ? model.slice(separator + 1) : model;
    const latest = [...linkedRuns].sort((a, b) =>
      b.run.started_at_utc.localeCompare(a.run.started_at_utc),
    )[0]!;
    const counts = failureCounts.get(conditionId) ?? {
      condition_id: conditionId,
      failed: 0,
      interrupted: 0,
      running: 0,
      claimed: 0,
    };
    const invalidReason = policy.invalid_conditions[conditionId];
    const diagnosticReason = policy.diagnostic_conditions[conditionId];
    const active = linkedRuns.some((row) => row.run.status === "running");
    groups.push({
      group_id: conditionId,
      condition_id: conditionId,
      model,
      provider,
      model_name: modelName,
      mode: condition.arm ?? arm,
      question_set_id:
        condition.question_set_id ??
        representative.config.question_set_id ??
        "unknown",
      question_sample_id: representative.config.question_sample_id ?? null,
      expected_question_ids: expectedIds,
      expected_questions: expectedQuestions,
      answered_questions: cells.length,
      coverage: expectedQuestions ? cells.length / expectedQuestions : 0,
      failed_cells: counts.failed,
      interrupted_cells: counts.interrupted,
      running_cells: counts.running,
      claimed_cells: counts.claimed,
      latest_run_status: latest.run.status,
      result_scope: resultScope,
      publication_status: invalidReason
        ? "invalid"
        : diagnosticReason
          ? "diagnostic-only"
          : active
            ? "running-partial"
            : resultScope === "smoke"
              ? "smoke"
              : "superseded",
      validity_reason: invalidReason ?? diagnosticReason ?? null,
      representative_run_id: representative.run.run_id,
      representative_tag: representative.run.tag,
      source_run_ids: linkedRuns.map((row) => row.run.run_id),
      owners: [...new Set(linkedRuns.map((row) => row.run.owner))],
      started_at_utc: linkedRuns[0]!.run.started_at_utc,
      finished_at_utc: latest.run.finished_at_utc,
      condition,
      llm_client: representative.config.llm_client ?? null,
      reasoning: representative.config.reasoning ?? null,
      concurrency: representative.config.conc ?? null,
      reader: representative.config.reader ?? null,
      code_identity: representative.config.code_identity ?? null,
      cells,
    });
  }

  // Select one current completed condition per provider/model/mode. Invalid and diagnostic-only
  // conditions remain visible but never displace a publishable condition.
  const selectionBuckets = new Map<string, GroupDraft[]>();
  for (const group of groups) {
    if (
      ["invalid", "diagnostic-only", "running-partial", "smoke"].includes(
        group.publication_status,
      )
    )
      continue;
    const key = `${group.model}|${group.mode}`;
    const bucket = selectionBuckets.get(key) ?? [];
    bucket.push(group);
    selectionBuckets.set(key, bucket);
  }
  for (const bucket of selectionBuckets.values()) {
    bucket.sort((a, b) => {
      if (a.coverage !== b.coverage) return b.coverage - a.coverage;
      return (b.finished_at_utc ?? b.started_at_utc).localeCompare(
        a.finished_at_utc ?? a.started_at_utc,
      );
    });
    const winner = bucket[0]!;
    if (winner.coverage >= policy.primary_coverage_threshold) {
      winner.publication_status = "primary";
      winner.validity_reason =
        winner.coverage === 1
          ? "Highest-coverage, newest publishable condition for this model and mode."
          : `Coverage ${(winner.coverage * 100).toFixed(1)}%; failed questions are kept and not filled with 0.5.`;
    } else {
      winner.publication_status = "diagnostic-only";
      winner.validity_reason = `Coverage ${(winner.coverage * 100).toFixed(1)}%, below the publication threshold of ${(policy.primary_coverage_threshold * 100).toFixed(1)}%.`;
    }
    for (const old of bucket.slice(1)) {
      old.publication_status = "superseded";
      old.validity_reason = `Superseded by ${winner.condition_id} as the current ${winner.model}/${winner.mode} condition.`;
    }
  }

  groups.sort(
    (a, b) =>
      a.model.localeCompare(b.model) ||
      a.mode.localeCompare(b.mode) ||
      a.condition_id.localeCompare(b.condition_id),
  );

  return groups;
}
