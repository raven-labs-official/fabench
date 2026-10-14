import assert from "node:assert/strict";
import test from "node:test";
import { buildConditionGroups } from "./brier/groups.js";
import { buildBrierReport } from "./brier/report.js";
import type { RegistryData } from "./brier/records.js";

const policy = {
  schema_version: "fixture",
  minimum_expected_questions: 1,
  primary_coverage_threshold: 1,
  invalid_conditions: {},
  diagnostic_conditions: {},
};

function registry(
  config = JSON.stringify({
    dataset: "beta-raven-bench/selected_300",
    llm: "fixture:model",
    selected_question_ids: ["q1"],
  }),
): RegistryData {
  return {
    runs: [{
      run_id: "fixture-run",
      tag: "fixture",
      owner: "fixture",
      status: "completed",
      expected_cells: 1,
      reused_cells: 0,
      succeeded_cells: 1,
      failed_cells: 0,
      interrupted_cells: 0,
      config_json: config,
      trace_directory: null,
      started_at_utc: "2026-09-30T00:00:00Z",
      last_heartbeat_utc: "2026-09-30T00:00:00Z",
      finished_at_utc: "2026-09-30T00:00:01Z",
      error: null,
    }],
    canonicalCells: [{
      condition_id: "fixture-condition",
      question_id: "q1",
      arm: "none",
      probability: 0.7,
      source_run_id: "fixture-run",
      trace_path: null,
      summary_json: "{}",
      completed_at_utc: "2026-09-30T00:00:01Z",
    }],
    statusRows: [],
  };
}

test("corrupt registry configuration cannot silently remove a run from the report", () => {
  for (const raw of ["{", "null", "[]", "7"]) {
    assert.throws(() => buildConditionGroups(registry(raw), policy), /fixture-run.*config_json/);
  }
  assert.deepEqual(buildConditionGroups(registry("{}"), policy), []);
});

test("corrupt resource summaries cannot be reported as absent metadata", () => {
  for (const raw of ["{", "null", "[]", "7"]) {
    const data = registry();
    data.canonicalCells[0]!.summary_json = raw;
    assert.throws(() => buildBrierReport({
      registry: data, questions: [], policy, registryPath: "fixture.sqlite", bootstrapIters: 1,
    }), /fixture-run.*fixture-condition.*q1.*summary_json/);
  }
});

test("legacy empty metadata retains its answer and unknown resource totals", () => {
  const report = buildBrierReport({
    registry: registry(), questions: [], policy, registryPath: "fixture.sqlite", bootstrapIters: 1,
  });
  assert.equal(report.answerTable.groups.length, 1);
  assert.equal(report.answerTable.groups[0]!.answered_questions, 1);
  assert.equal(report.answerTable.groups[0]!.resources.cells_with_summary, 0);
  assert.equal(report.answerTable.groups[0]!.resources.known_total_cost_usd, null);
});
