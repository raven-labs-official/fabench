import { type BetaRavenQuestion } from "../../datasets/beta-raven-bench.js";
import {
  brierCI,
  brierIndex,
  brierIndexInterval,
  pairedBrierDiff,
} from "../../scoring/bootstrap.js";
import { expectedCalibrationError } from "../../scoring/brier.js";
import { isEmpiricalDifficultyAnswer } from "../difficulty-pool.js";
import { parseRegistryObject } from "../../experiments/registry-json.js";

import { buildConditionGroups } from "./groups.js";
import {
  type CanonicalCell,
  type Policy,
  type RegistryData,
} from "./records.js";

function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function scoreRows(
  rows: readonly { probability: number; outcome: 0 | 1 }[],
  bootstrapIters: number,
) {
  if (!rows.length) return null;
  const forecasts = rows.map((row) => row.probability);
  const outcomes = rows.map((row) => row.outcome);
  const raw = brierCI(forecasts, outcomes, bootstrapIters);
  return {
    n: rows.length,
    raw_brier: raw,
    brier_index: brierIndexInterval(raw),
    ece_10_bin: expectedCalibrationError(forecasts, outcomes),
    mean_probability: mean(forecasts),
  };
}

function resourceSummary(cells: readonly CanonicalCell[]) {
  const resources = cells.map((cell) =>
    parseRegistryObject<Record<string, unknown>>(
      cell.summary_json,
      `${cell.source_run_id}/${cell.condition_id}/${cell.question_id} summary_json`,
    ),
  );
  const numeric = (name: string) =>
    resources
      .map((row) => row[name])
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
  const cost = numeric("cost_usd");
  return {
    cells_with_summary: resources.filter((row) => Object.keys(row).length > 0)
      .length,
    mean_input_tokens: mean(numeric("input_tokens")),
    mean_output_tokens: mean(numeric("output_tokens")),
    mean_duration_seconds: (() => {
      const value = mean(numeric("duration_ms"));
      return value == null ? null : value / 1000;
    })(),
    known_total_cost_usd: cost.length
      ? cost.reduce((sum, value) => sum + value, 0)
      : null,
    mean_known_cost_usd: mean(cost),
    cost_scope:
      "canonical cells only; zero may mean native non-USD pricing was unavailable",
  };
}

function dimensionValues(question: BetaRavenQuestion): Record<string, string> {
  return {
    topic: question.category,
    difficulty: question.difficulty,
    archetype: question.archetype,
    outcome: question.ground_truth === 1 ? "yes" : "no",
  };
}

/** Calculate answer tables and comparisons from already loaded records. */
export function buildBrierReport({
  registry,
  questions,
  policy,
  registryPath,
  bootstrapIters,
}: {
  registry: RegistryData;
  questions: BetaRavenQuestion[];
  policy: Policy;
  registryPath: string;
  bootstrapIters: number;
}) {
  const groups = buildConditionGroups(registry, policy);
  const questionById = new Map(
    questions.map((question) => [question.question_id, question]),
  );
  const groupSummaries = groups.map((group) => {
    const scoredRows = group.cells
      .map((cell) => {
        const question = questionById.get(cell.question_id);
        return question?.ground_truth == null
          ? null
          : {
              probability: cell.probability,
              outcome: question.ground_truth as 0 | 1,
            };
      })
      .filter((row): row is { probability: number; outcome: 0 | 1 } =>
        Boolean(row),
      );
    return {
      group_id: group.group_id,
      condition_id: group.condition_id,
      model: group.model,
      provider: group.provider,
      model_name: group.model_name,
      mode: group.mode,
      result_scope: group.result_scope,
      publication_status: group.publication_status,
      validity_reason: group.validity_reason,
      expected_questions: group.expected_questions,
      answered_questions: group.answered_questions,
      coverage: group.coverage,
      failed_cells: group.failed_cells,
      interrupted_cells: group.interrupted_cells,
      latest_run_status: group.latest_run_status,
      score: scoreRows(scoredRows, bootstrapIters),
      resources: resourceSummary(group.cells),
      representative_run_id: group.representative_run_id,
      representative_tag: group.representative_tag,
      source_run_ids: group.source_run_ids,
      owners: group.owners,
      question_set_id: group.question_set_id,
      question_sample_id: group.question_sample_id,
      expected_question_ids: group.expected_question_ids,
      condition: group.condition,
      llm_client: group.llm_client,
      reasoning: group.reasoning,
      concurrency: group.concurrency,
      reader: group.reader,
      code_identity: group.code_identity,
    };
  });

  const dimensionScores: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    const buckets = new Map<
      string,
      Array<{ probability: number; outcome: 0 | 1 }>
    >();
    for (const cell of group.cells) {
      const question = questionById.get(cell.question_id);
      if (!question || question.ground_truth == null) continue;
      for (const [dimension, value] of Object.entries(
        dimensionValues(question),
      )) {
        const key = `${dimension}\u0000${value}`;
        const rows = buckets.get(key) ?? [];
        rows.push({
          probability: cell.probability,
          outcome: question.ground_truth as 0 | 1,
        });
        buckets.set(key, rows);
      }
    }
    for (const [key, rows] of buckets) {
      const [dimension, value] = key.split("\u0000") as [string, string];
      dimensionScores.push({
        group_id: group.group_id,
        model: group.model,
        mode: group.mode,
        publication_status: group.publication_status,
        dimension,
        value,
        score: scoreRows(rows, bootstrapIters),
      });
    }
  }

  const primaryGroups = groups.filter(
    (group) => group.publication_status === "primary",
  );
  const primaryGroupIds = new Set(primaryGroups.map((group) => group.group_id));
  const comparableQuestionMinimumGroups = Math.max(
    1,
    Math.ceil(primaryGroups.length * 0.8),
  );
  const questionRows = questions.map((question, index) => {
    const answers = groups.flatMap((group) => {
      const cell = group.cells.find(
        (candidate) => candidate.question_id === question.question_id,
      );
      if (!cell || question.ground_truth == null) return [];
      return [
        {
          group_id: group.group_id,
          model: group.model,
          mode: group.mode,
          result_scope: group.result_scope,
          publication_status: group.publication_status,
          probability: cell.probability,
          raw_brier: (cell.probability - question.ground_truth) ** 2,
          source_run_id: cell.source_run_id,
          trace_path: cell.trace_path,
          completed_at_utc: cell.completed_at_utc,
        },
      ];
    });
    const primaryLosses = answers
      .filter((answer) => primaryGroupIds.has(answer.group_id))
      .map((answer) => answer.raw_brier);
    const empiricalDifficultyAnswers = answers.filter(
      isEmpiricalDifficultyAnswer,
    );
    const empiricalDifficultyLosses = empiricalDifficultyAnswers.map(
      (answer) => answer.raw_brier,
    );
    const averageRawBrier = mean(primaryLosses);
    const empiricalDifficultyAverage = mean(empiricalDifficultyLosses);
    return {
      question_no: index + 1,
      question_id: question.question_id,
      question: question.question_text,
      resolution_criteria: question.resolution_criteria,
      as_of_utc: question.as_of_date ?? null,
      resolution_date: question.resolution_date,
      outcome: question.ground_truth,
      topic: question.category,
      difficulty: question.difficulty,
      archetype: question.archetype,
      answers,
      cross_group: {
        primary_group_answers: primaryLosses.length,
        average_raw_brier: averageRawBrier,
        median_raw_brier: median(primaryLosses),
        brier_index_from_average:
          averageRawBrier == null ? null : brierIndex(averageRawBrier),
      },
      empirical_difficulty: {
        answer_policy: "primary_plus_all_smoke",
        answers: empiricalDifficultyLosses.length,
        primary_answers: empiricalDifficultyAnswers.filter(
          (answer) => answer.publication_status === "primary",
        ).length,
        smoke_answers: empiricalDifficultyAnswers.filter(
          (answer) => answer.result_scope === "smoke",
        ).length,
        average_raw_brier: empiricalDifficultyAverage,
        median_raw_brier: median(empiricalDifficultyLosses),
        brier_index_from_average:
          empiricalDifficultyAverage == null
            ? null
            : brierIndex(empiricalDifficultyAverage),
      },
    };
  });

  const empiricalDifficultyRanking = [...questionRows]
    .filter(
      (question) => question.empirical_difficulty.average_raw_brier != null,
    )
    .sort(
      (a, b) =>
        b.empirical_difficulty.average_raw_brier! -
          a.empirical_difficulty.average_raw_brier! ||
        a.question_no - b.question_no,
    )
    .map((question, index) => ({
      rank: index + 1,
      tier: index < 100 ? "hard" : index < 200 ? "medium" : "easy",
      tier_rank: (index % 100) + 1,
      question_no: question.question_no,
      question_id: question.question_id,
      question: question.question,
      topic: question.topic,
      difficulty: question.difficulty,
      archetype: question.archetype,
      outcome: question.outcome,
      answers: question.empirical_difficulty.answers,
      primary_answers: question.empirical_difficulty.primary_answers,
      smoke_answers: question.empirical_difficulty.smoke_answers,
      average_raw_brier: question.empirical_difficulty.average_raw_brier,
      median_raw_brier: question.empirical_difficulty.median_raw_brier,
      brier_index_from_average:
        question.empirical_difficulty.brier_index_from_average,
    }));

  const rankedHardestQuestions = questionRows
    .filter((question) => question.cross_group.average_raw_brier != null)
    .sort(
      (a, b) =>
        b.cross_group.average_raw_brier! - a.cross_group.average_raw_brier! ||
        a.question_no - b.question_no,
    )
    .map((question, index) => ({
      rank: index + 1,
      question_no: question.question_no,
      question_id: question.question_id,
      question: question.question,
      topic: question.topic,
      difficulty: question.difficulty,
      archetype: question.archetype,
      outcome: question.outcome,
      primary_group_answers: question.cross_group.primary_group_answers,
      average_raw_brier: question.cross_group.average_raw_brier,
      median_raw_brier: question.cross_group.median_raw_brier,
      brier_index_from_average: question.cross_group.brier_index_from_average,
    }));
  const hardestQuestions = rankedHardestQuestions
    .filter(
      (question) =>
        question.primary_group_answers >= comparableQuestionMinimumGroups,
    )
    .map((question, index) => ({ ...question, rank: index + 1 }));

  const crossGroupDimensions: Array<Record<string, unknown>> = [];
  for (const dimension of [
    "topic",
    "difficulty",
    "archetype",
    "outcome",
  ] as const) {
    const values = new Set(
      questions.map((question) => dimensionValues(question)[dimension]),
    );
    for (const value of values) {
      const perGroup = primaryGroups.flatMap((group) => {
        const losses = group.cells.flatMap((cell) => {
          const question = questionById.get(cell.question_id);
          if (
            !question ||
            question.ground_truth == null ||
            dimensionValues(question)[dimension] !== value
          ) {
            return [];
          }
          return [(cell.probability - question.ground_truth) ** 2];
        });
        const average = mean(losses);
        return average == null
          ? []
          : [
              {
                group_id: group.group_id,
                n: losses.length,
                raw_brier: average,
              },
            ];
      });
      const balancedRawBrier = mean(perGroup.map((row) => row.raw_brier));
      crossGroupDimensions.push({
        dimension,
        value,
        primary_groups: perGroup.length,
        question_group_cells: perGroup.reduce((sum, row) => sum + row.n, 0),
        group_balanced_raw_brier: balancedRawBrier,
        group_balanced_brier_index:
          balancedRawBrier == null ? null : brierIndex(balancedRawBrier),
        per_group: perGroup,
      });
    }
  }

  const pairwise: Array<
    Record<string, unknown> & { p_value: number; p_value_holm: number }
  > = [];
  for (let i = 0; i < primaryGroups.length; i += 1) {
    for (let j = i + 1; j < primaryGroups.length; j += 1) {
      const a = primaryGroups[i]!;
      const b = primaryGroups[j]!;
      const sameModel = a.model === b.model;
      const sameMode = a.mode === b.mode;
      if (!sameModel && !sameMode) continue;
      const bByQuestion = new Map(
        b.cells.map((cell) => [cell.question_id, cell]),
      );
      const common = a.cells.flatMap((aCell) => {
        const bCell = bByQuestion.get(aCell.question_id);
        const question = questionById.get(aCell.question_id);
        if (!bCell || !question || question.ground_truth == null) return [];
        return [
          {
            a: aCell.probability,
            b: bCell.probability,
            outcome: question.ground_truth as 0 | 1,
          },
        ];
      });
      if (!common.length) continue;
      const aForecasts = common.map((row) => row.a);
      const bForecasts = common.map((row) => row.b);
      const outcomes = common.map((row) => row.outcome);
      const comparison = pairedBrierDiff(
        aForecasts,
        bForecasts,
        outcomes,
        bootstrapIters,
      );
      const aRaw = mean(
        aForecasts.map((forecast, k) => (forecast - outcomes[k]!) ** 2),
      )!;
      const bRaw = mean(
        bForecasts.map((forecast, k) => (forecast - outcomes[k]!) ** 2),
      )!;
      const pValue = Math.min(
        1,
        2 * Math.min(comparison.probAbetter, 1 - comparison.probAbetter),
      );
      pairwise.push({
        comparison_type: sameModel
          ? "same-model-different-mode"
          : "same-mode-different-model",
        group_a: a.group_id,
        group_b: b.group_id,
        model_a: a.model,
        model_b: b.model,
        mode_a: a.mode,
        mode_b: b.mode,
        common_questions: common.length,
        raw_brier_a: aRaw,
        raw_brier_b: bRaw,
        raw_brier_diff_a_minus_b: comparison.diff,
        raw_brier_diff_ci_lo: comparison.lo,
        raw_brier_diff_ci_hi: comparison.hi,
        brier_index_a: brierIndex(aRaw),
        brier_index_b: brierIndex(bRaw),
        brier_index_lift_a_minus_b: brierIndex(aRaw) - brierIndex(bRaw),
        bootstrap_probability_a_better: comparison.probAbetter,
        p_value: pValue,
        p_value_holm: pValue,
        significant_95_unadjusted: comparison.lo > 0 || comparison.hi < 0,
        significant_95_holm: false,
      });
    }
  }

  // Holm adjustment is applied across the pre-specified same-model and same-mode comparisons.
  const orderedP = pairwise
    .map((row, index) => ({ index, p: row.p_value }))
    .sort((a, b) => a.p - b.p);
  let runningAdjusted = 0;
  for (let rank = 0; rank < orderedP.length; rank += 1) {
    const item = orderedP[rank]!;
    const adjusted = Math.min(1, item.p * (orderedP.length - rank));
    runningAdjusted = Math.max(runningAdjusted, adjusted);
    pairwise[item.index]!.p_value_holm = runningAdjusted;
    pairwise[item.index]!.significant_95_holm = runningAdjusted < 0.05;
  }

  const generatedAtUtc = new Date().toISOString();
  const answerTable = {
    schema_version: "raven.final-answer-table.v1",
    generated_at_utc: generatedAtUtc,
    benchmark: "beta-raven-bench",
    question_set_id: groupSummaries[0]?.question_set_id ?? null,
    scoring: {
      raw_brier: "mean((probability - outcome)^2); lower is better",
      brier_index: "(1 - sqrt(raw_brier)) * 100; higher is better",
      missing_policy:
        "missing/failed answers remain null and are never replaced with 0.5",
      smoke_policy: `conditions with fewer than ${policy.minimum_expected_questions} expected questions are included with result_scope=smoke and are not primary-eligible`,
    },
    groups: groupSummaries,
    questions: questionRows,
  };
  const analysis = {
    schema_version: "raven.brier-index-analysis.v1",
    generated_at_utc: generatedAtUtc,
    benchmark: "beta-raven-bench",
    registry_path: registryPath,
    policy,
    inclusion_policy: {
      smoke_in_answer_table: true,
      smoke_in_group_summaries: true,
      smoke_primary_eligible: false,
      smoke_threshold_expected_questions: policy.minimum_expected_questions,
      smoke_in_empirical_question_difficulty: true,
      formal_significance_primary_only: true,
    },
    bootstrap: {
      iterations: bootstrapIters,
      confidence_level: 0.95,
      unit: "question",
    },
    group_summaries: groupSummaries,
    group_dimension_scores: dimensionScores,
    cross_group_dimension_scores: crossGroupDimensions,
    hardest_questions: hardestQuestions,
    hardest_questions_all_available: rankedHardestQuestions,
    empirical_question_difficulty: empiricalDifficultyRanking,
    empirical_question_difficulty_policy: {
      included_answers: "publication_status=primary OR result_scope=smoke",
      weighting: "Every successful condition-level answer is equally weighted.",
      formal_pairwise_significance_uses_this_pool: false,
    },
    hardest_question_comparability: {
      primary_groups: primaryGroups.length,
      minimum_primary_group_answers: comparableQuestionMinimumGroups,
      rule: "At least 80% of primary groups must answer a question for the comparable ranking.",
    },
    category_note:
      "Topic/difficulty/archetype values are copied from the benchmark dataset and are not reclassified by this analysis; category quality should be audited separately.",
    pairwise_comparisons: pairwise,
  };
  return { answerTable, analysis };
}

export type BrierReport = ReturnType<typeof buildBrierReport>;
