import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { TraceArchive } from "../tracing/trace-archive.js";
import { ExperimentRegistry } from "./registry.js";

const cells = [
  { conditionId: "condition:a", questionId: "q1", arm: "web-filter" },
  { conditionId: "condition:a", questionId: "q2", arm: "web-filter" },
];

test("listings retain corrupt runs explicitly while targeted reads reject their configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-registry-corrupt-config-"));
  const path = join(root, "fixture.sqlite");
  const registry = new ExperimentRegistry(path);
  const fixtureDb = new DatabaseSync(path);
  try {
    registry.prepareRun({ runId: "corrupt-run", experimentKey: "fixture", tag: "fixture",
      expectedCells: 1, config: {}, cells: [cells[0]!] });
    for (const raw of ["{", "null", "[]", "7"]) {
      fixtureDb.prepare("UPDATE runs SET config_json=? WHERE run_id=?").run(raw, "corrupt-run");
      const row = registry.listRuns()[0]!;
      assert.equal(row.config, null);
      assert.match(row.configError!, /corrupt-run.*config_json/);
      assert.throws(() => registry.getRun("corrupt-run"), /corrupt-run.*config_json/);
    }
    fixtureDb.prepare("UPDATE runs SET config_json=? WHERE run_id=?").run("{}", "corrupt-run");
    assert.deepEqual(registry.listRuns()[0]!.config, {});
    assert.equal(registry.listRuns()[0]!.configError, undefined);
    assert.equal(registry.getRun("missing"), null);
  } finally {
    fixtureDb.close();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("equivalent promotion rolls back every cell when source metadata is corrupt", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-registry-corrupt-promotion-"));
  const source = { condition_id: "source", arm: "none", code_fingerprint_sha256: "old" };
  const target = { ...source, condition_id: "target", code_fingerprint_sha256: "new" };
  const archive = new TraceArchive({ runId: "source-run", resultsDir: root, tag: "source",
    expectedCells: 2, run: { conditions: [source] } });
  for (const [index, questionId] of ["q1", "q2"].entries()) {
    archive.beginCell({ question_id: questionId, arm: "none", question: "Fixture?",
      as_of: "2026-01-01", condition: source }).finish("success", {
      question_id: questionId, arm: "none", probability: 0.6 + index / 100,
    });
  }
  archive.finish("completed");
  const path = join(root, "fixture.sqlite");
  const registry = new ExperimentRegistry(path);
  const fixtureDb = new DatabaseSync(path);
  try {
    registry.importTraceArchive(archive.directory);
    fixtureDb.prepare("UPDATE canonical_cells SET summary_json=? WHERE question_id=?").run("{", "q2");
    assert.throws(() => registry.promoteEquivalentCondition({ sourceConditionId: "source",
      targetCondition: target, reason: "fixture" }), /source-run.*source.*q2.*summary_json/);
    assert.equal(registry.getReusable("target", "q1"), null);
    assert.equal(registry.getReusable("target", "q2"), null);
    assert.equal(registry.getReusable("source", "q2")!.probability, 0.61);
    fixtureDb.prepare("UPDATE canonical_cells SET summary_json=? WHERE question_id=?").run("{}", "q2");
    assert.equal(registry.promoteEquivalentCondition({ sourceConditionId: "source",
      targetCondition: target, reason: "fixture after metadata recovery" }).inserted, 2);
  } finally {
    fixtureDb.close();
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry blocks active duplicates, reuses success, and retries failures", () => {
  const registry = new ExperimentRegistry(":memory:");
  try {
    const first = registry.prepareRun({
      runId: "run-1",
      experimentKey: "experiment-a",
      tag: "first",
      expectedCells: 2,
      config: { llm: "test" },
      cells,
    });
    assert.equal(first.claimed.length, 2);
    assert.equal(first.reused.length, 0);
    registry.markRunning(first.runId, "/tmp/run-1");

    const blocked = registry.prepareRun({
      runId: "run-blocked",
      experimentKey: "experiment-a",
      tag: "duplicate",
      expectedCells: 2,
      config: {},
      cells,
    });
    assert.equal(blocked.blocked.length, 2);
    assert.equal(registry.listRuns().some((run) => run.runId === "run-blocked"), false);

    registry.markCellRunning("run-1", "condition:a", "q1");
    registry.recordCell("run-1", {
      ...cells[0]!,
      status: "success",
      probability: 0.63,
      tracePath: "/tmp/run-1/q1.jsonl",
    });
    registry.recordCell("run-1", { ...cells[1]!, status: "failed" });
    registry.finishRun("run-1", "failed", "one cell failed");

    const resume = registry.prepareRun({
      runId: "run-2",
      experimentKey: "experiment-a",
      tag: "resume",
      expectedCells: 2,
      config: {},
      cells,
    });
    assert.deepEqual(resume.reused.map((cell) => cell.questionId), ["q1"]);
    assert.deepEqual(resume.claimed.map((cell) => cell.questionId), ["q2"]);
    assert.equal(resume.reused[0]?.probability, 0.63);

    registry.markRunning("run-2", "/tmp/run-2");
    registry.recordCell("run-2", {
      ...cells[1]!,
      status: "success",
      probability: 0.41,
    });
    registry.finishRun("run-2", "completed");

    const allReused = registry.prepareRun({
      runId: "run-3",
      experimentKey: "experiment-a",
      tag: "all-reused",
      expectedCells: 2,
      config: {},
      cells,
    });
    assert.equal(allReused.claimed.length, 0);
    assert.equal(allReused.reused.length, 2);
    registry.markRunning("run-3", null);
    registry.finishRun("run-3", "completed");

    const status = registry.listRuns().find((run) => run.runId === "run-3");
    assert.equal(status?.reusedCells, 2);
    assert.equal(status?.succeededCells, 0);
    assert.equal(status?.status, "completed");
  } finally {
    registry.close();
  }
});

test("replicate mode bypasses completed-cell reuse but not active claims", () => {
  const registry = new ExperimentRegistry(":memory:");
  try {
    assert.throws(
      () => registry.prepareRun({
        runId: "invalid-replica",
        experimentKey: "experiment-a",
        tag: "invalid-replica",
        expectedCells: 1,
        config: {},
        cells: [cells[0]!],
        replicate: true,
      }),
      /replicateReason/,
    );

    const original = registry.prepareRun({
      runId: "original",
      experimentKey: "experiment-a",
      tag: "original",
      expectedCells: 1,
      config: {},
      cells: [cells[0]!],
    });
    registry.markRunning(original.runId, null);
    registry.recordCell(original.runId, {
      ...cells[0]!,
      status: "success",
      probability: 0.5,
    });
    registry.finishRun(original.runId, "completed");

    const replica = registry.prepareRun({
      runId: "replica",
      experimentKey: "experiment-a",
      tag: "replica",
      expectedCells: 1,
      config: {},
      cells: [cells[0]!],
      replicate: true,
      replicateReason: "reproducibility",
    });
    assert.equal(replica.reused.length, 0);
    assert.equal(replica.claimed.length, 1);
  } finally {
    registry.close();
  }
});

test("invalidating a paused arm retracts its canonical cells and releases claims", () => {
  const registry = new ExperimentRegistry(":memory:");
  try {
    const first = registry.prepareRun({
      runId: "run-paused",
      experimentKey: "experiment-paused",
      tag: "paused-web",
      expectedCells: 2,
      config: {},
      cells,
    });
    registry.markRunning(first.runId, "/tmp/run-paused");
    registry.recordCell(first.runId, {
      ...cells[0]!,
      status: "success",
      probability: 0.7,
    });

    assert.equal(
      registry.getReusable("condition:a", "q1")?.probability,
      0.7,
    );
    assert.equal(registry.invalidateRunArm(first.runId, "web-filter"), 1);
    assert.equal(registry.getReusable("condition:a", "q1"), null);
    registry.finishRun(first.runId, "failed", "web_filter_circuit_breaker");

    const retry = registry.prepareRun({
      runId: "run-retry",
      experimentKey: "experiment-paused",
      tag: "retry-web",
      expectedCells: 2,
      config: {},
      cells,
    });
    assert.deepEqual(
      retry.claimed.map((cell) => cell.questionId).sort(),
      ["q1", "q2"],
    );
  } finally {
    registry.close();
  }
});

test("a failed run preserves completed canonical cells for the next completion run", () => {
  const registry = new ExperimentRegistry(":memory:");
  try {
    const first = registry.prepareRun({
      runId: "run-partial-failure",
      experimentKey: "experiment-completion",
      tag: "partial-web",
      expectedCells: 2,
      config: {},
      cells,
    });
    registry.markRunning(first.runId, "/tmp/run-partial-failure");
    registry.recordCell(first.runId, {
      ...cells[0]!,
      status: "success",
      probability: 0.73,
    });
    registry.finishRun(first.runId, "failed", "one reviewer failed");

    assert.equal(
      registry.getReusable("condition:a", "q1")?.probability,
      0.73,
    );
    const completion = registry.prepareRun({
      runId: "run-completion",
      experimentKey: "experiment-completion",
      tag: "complete-web",
      expectedCells: 2,
      config: {},
      cells,
    });
    assert.deepEqual(
      completion.reused.map((cell) => cell.questionId),
      ["q1"],
    );
    assert.deepEqual(
      completion.claimed.map((cell) => cell.questionId),
      ["q2"],
    );
  } finally {
    registry.close();
  }
});

test("new-schema trace archives can seed reusable cells", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-registry-import-"));
  const archive = new TraceArchive({
    runId: "import-source",
    resultsDir: root,
    tag: "import-source",
    expectedCells: 1,
    run: { llm: "test", conditions: [{ condition_id: "condition:import" }] },
  });
  const cell = archive.beginCell({
    question_id: "q-import",
    arm: "frozen",
    question: "Will this import?",
    as_of: "2026-01-01",
    condition: { condition_id: "condition:import" },
  });
  cell.finish("success", { probability: 0.72 });
  archive.finish("completed");

  const registry = new ExperimentRegistry(":memory:");
  try {
    const imported = registry.importTraceArchive(archive.directory);
    assert.equal(imported.cells, 1);
    assert.equal(imported.reusable, 1);
    assert.equal(
      registry.getReusable("condition:import", "q-import")?.probability,
      0.72,
    );
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("audited legacy promotion accepts only verified closed-book success", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-registry-promote-none-"));
  const archive = new TraceArchive({
    runId: "legacy-closed-book",
    resultsDir: root,
    tag: "legacy-closed-book",
    expectedCells: 2,
    run: {
      llm: "glm:test-model",
      llm_client: { id: "glm:test-model" },
    },
  });
  const success = archive.beginCell({
    question_id: "q-promote",
    arm: "none",
    question: "Will this promote?",
    as_of: "2026-01-01",
  });
  success.record({
    type: "model_attempt_started",
    data: { tools_enabled: false, effort: null },
  });
  success.finish("success", {
    probability: 0.64,
    predictor_id: "agentic:glm:test-model:closed-book:n0",
    tool_calls: [],
  });
  const failed = archive.beginCell({
    question_id: "q-failed",
    arm: "none",
    question: "Will this fail?",
    as_of: "2026-01-01",
  });
  failed.finish("failed", { probability: null, tool_calls: [] });
  archive.finish("completed");

  const registry = new ExperimentRegistry(":memory:");
  try {
    const promoted = registry.promoteLegacyClosedBook({
      directory: archive.directory,
      conditionId: "raven-condition:modern-none",
      expectedModel: "glm:test-model",
      reason: "prompt and generation parameters audited",
    });
    assert.deepEqual(promoted, {
      sourceRunId: "legacy-closed-book",
      eligible: 1,
      inserted: 1,
      alreadyPresent: 0,
      rejected: 1,
    });
    assert.equal(
      registry.getReusable("raven-condition:modern-none", "q-promote")?.probability,
      0.64,
    );
    const repeated = registry.promoteLegacyClosedBook({
      directory: archive.directory,
      conditionId: "raven-condition:modern-none",
      expectedModel: "glm:test-model",
      reason: "same audited import is idempotent",
    });
    assert.equal(repeated.inserted, 0);
    assert.equal(repeated.alreadyPresent, 1);
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("equivalent-condition promotion reuses only trace-verified identical treatment", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-registry-promote-equivalent-"));
  const sourceCondition = {
    condition_id: "raven-condition:source",
    arm: "web-filter",
    question_sample_id: "questions:n6",
    code_fingerprint_sha256: "source-code",
    protocol_version: "raven.forecast-value.v1",
    question_set_id: "questions:v1",
    model: "bailian:glm-5.2",
    reasoning_mode: null,
    thinking_effort: null,
    search_type: "web-filter",
    max_tool_calls: 50,
    max_results_per_search: 20,
    filter_model: "deepseek:deepseek-v4-flash",
  };
  const targetCondition = {
    ...sourceCondition,
    condition_id: "raven-condition:target",
    question_sample_id: "questions:n293",
    code_fingerprint_sha256: "target-code",
    filter_fallback_model: null,
    filter_fallback_reasoning: null,
  };
  const archive = new TraceArchive({
    runId: "equivalent-source",
    resultsDir: root,
    tag: "equivalent-source",
    expectedCells: 1,
    run: { llm: "bailian:glm-5.2", conditions: [sourceCondition] },
  });
  const cell = archive.beginCell({
    question_id: "q-equivalent",
    arm: "web-filter",
    question: "Will this be reused?",
    as_of: "2026-01-01",
    condition: sourceCondition,
  });
  cell.finish("success", {
    question_id: "q-equivalent",
    arm: "web-filter",
    probability: 0.61,
  });
  archive.finish("completed");

  const registry = new ExperimentRegistry(":memory:");
  try {
    registry.importTraceArchive(archive.directory);
    const promoted = registry.promoteEquivalentCondition({
      sourceConditionId: "raven-condition:source",
      targetCondition,
      reason: "only the page-dater preflight timeout implementation changed",
    });
    assert.deepEqual(promoted, {
      sourceConditionId: "raven-condition:source",
      targetConditionId: "raven-condition:target",
      eligible: 1,
      inserted: 1,
      alreadyPresent: 0,
    });
    assert.equal(
      registry.getReusable("raven-condition:target", "q-equivalent")?.probability,
      0.61,
    );
    const repeated = registry.promoteEquivalentCondition({
      sourceConditionId: "raven-condition:source",
      targetCondition,
      reason: "idempotency check",
    });
    assert.equal(repeated.inserted, 0);
    assert.equal(repeated.alreadyPresent, 1);
    assert.throws(
      () => registry.promoteEquivalentCondition({
        sourceConditionId: "raven-condition:source",
        targetCondition: { ...targetCondition, model: "bailian:another-model" },
        reason: "must be rejected",
      }),
      /treatments differ/,
    );
    assert.throws(
      () => registry.promoteEquivalentCondition({
        sourceConditionId: "raven-condition:source",
        targetCondition: {
          ...targetCondition,
          filter_fallback_model: "bailian:qwen-flash",
        },
        reason: "a real fallback is a treatment change",
      }),
      /treatments differ/,
    );
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
