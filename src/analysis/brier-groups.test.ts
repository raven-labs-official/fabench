import assert from "node:assert/strict";
import test from "node:test";
import { buildConditionGroups } from "./brier/groups.js";
import type { RegistryData } from "./brier/records.js";

test("condition selection prioritizes coverage and retains invalid, running, and smoke groups separately", () => {
  const registry: RegistryData = {
    runs: [],
    canonicalCells: [],
    statusRows: [],
  };
  const cases = [
    { id: "full", completed: 3, expected: 3, status: "completed" },
    { id: "partial-newer", completed: 2, expected: 3, status: "completed" },
    { id: "invalid-newest", completed: 3, expected: 3, status: "completed" },
    { id: "smoke", completed: 1, expected: 1, status: "completed" },
    { id: "running", completed: 3, expected: 3, status: "running" },
  ];
  for (const [index, entry] of cases.entries()) {
    const stamp = `2026-09-0${index + 1}T00:00:00Z`;
    registry.runs.push({
      run_id: entry.id,
      tag: entry.id,
      owner: "fixture",
      status: entry.status,
      expected_cells: entry.expected,
      reused_cells: 0,
      succeeded_cells: entry.completed,
      failed_cells: 0,
      interrupted_cells: 0,
      trace_directory: null,
      started_at_utc: stamp,
      last_heartbeat_utc: stamp,
      finished_at_utc: stamp,
      error: null,
      config_json: JSON.stringify({
        dataset: "beta-raven-bench/selected_300",
        llm: "fixture:model",
        selected_question_ids: Array.from(
          { length: entry.expected },
          (_, i) => `q${i}`,
        ),
        conditions: [
          { condition_id: entry.id, model: "fixture:model", arm: "none" },
        ],
      }),
    });
    for (let i = 0; i < entry.completed; i++) {
      registry.canonicalCells.push({
        condition_id: entry.id,
        question_id: `q${i}`,
        arm: "none",
        probability: 0.7,
        source_run_id: entry.id,
        trace_path: null,
        summary_json: "{}",
        completed_at_utc: stamp,
      });
      registry.statusRows.push({
        run_id: entry.id,
        condition_id: entry.id,
        status: "success",
      });
    }
  }
  const groups = buildConditionGroups(registry, {
    schema_version: "fixture",
    minimum_expected_questions: 3,
    primary_coverage_threshold: 0.9,
    invalid_conditions: { "invalid-newest": "fixture exclusion" },
    diagnostic_conditions: {},
  });
  const statuses = Object.fromEntries(
    groups.map((g) => [g.condition_id, g.publication_status]),
  );
  assert.deepEqual(statuses, {
    full: "primary",
    "partial-newer": "superseded",
    "invalid-newest": "invalid",
    smoke: "smoke",
    running: "running-partial",
  });
  assert.equal(
    groups.find((g) => g.condition_id === "partial-newer")!.coverage,
    2 / 3,
  );
});
