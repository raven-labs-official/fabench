import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LlmClient } from "../llm/benchmark-client.js";
import type { Question } from "../types.js";
import { readForecastArms, readForecastOptions } from "./forecast/options.js";
import { loadForecastQuestions } from "./forecast/questions.js";
import { reportForecastQuality } from "./forecast/report.js";
import {
  buildResourceRows,
  createResourceCounters,
} from "./forecast/resources.js";

test("parsed options carry the requested arms and question selection independently of later argv", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "forecast-modules-"));
  const argv = process.argv;
  t.after(() => {
    process.argv = argv;
    rmSync(directory, { recursive: true, force: true });
  });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const file = join(directory, "questions.jsonl");
  writeFileSync(
    file,
    ["A", "B", "C"]
      .map((id) =>
        JSON.stringify({
          uid: id,
          question: `Will event ${id} happen?`,
          anchor: "2026-03-01T00:00:00Z",
          resolution_date: "2026-04-01T00:00:00Z",
          truth: 1,
          source_feed: "test",
        }),
      )
      .join("\n"),
  );
  process.argv = [
    argv[0]!,
    "forecast-value.ts",
    "--preset",
    "custom",
    "--settings",
    "none,web",
    "--ids",
    "braven::b,C",
    "--questions-file",
    file,
    "--n",
    "1",
    "--max-tool-calls",
    "7",
    "--include-china-filtered",
    "1",
  ];
  const options = readForecastOptions();
  process.argv = [argv[0]!, "forecast-value.ts"];
  assert.deepEqual(readForecastArms(options).columns, ["none", "web-filter"]);
  assert.equal(options.maxToolCalls, 7);
  assert.deepEqual(
    loadForecastQuestions(options, { offline: true }).questions.map((q) => q.question_id),
    ["B", "C"],
  );
});

test("quality reports score available cells and compare arms only on their shared successes", (t) => {
  t.mock.method(console, "log", () => {});
  const questions: Question[] = ["A", "B", "C"].map((id) => ({
    question_id: id,
    question_text: id,
    resolution_criteria: "",
    resolution_date: "2026-04-01",
    ground_truth: 1,
    market_price_at_freeze: null,
    category: "test",
    difficulty_level: "",
    source: "test",
    language: "en",
  }));
  const report = reportForecastQuality({
    columns: ["none", "frozen"],
    questions,
    topics: {},
    iters: 100,
    outcomes: [1, 0, 1],
    forecasts: { none: [0.2, null, 0.7], frozen: [0.8, 0.4, null] },
  });
  const rows = report.rows as {
    n: number;
    brier: { point: number };
    bss: { point: number } | null;
  }[];
  assert.deepEqual(
    rows.map((row) => row.n),
    [2, 2],
  );
  assert.ok(Math.abs(rows[0]!.brier.point - 0.365) < 1e-12);
  assert.ok(Math.abs(rows[1]!.brier.point - 0.1) < 1e-12);
  assert.equal(rows[1]!.bss!.point, 0.9375);
  const paired = report.pairs[0] as {
    diff: { diff: number; lo: number; hi: number };
  };
  for (const value of [paired.diff.diff, paired.diff.lo, paired.diff.hi])
    assert.ok(Math.abs(value - 0.6) < 1e-12);
});

test("resource reports separate reused and failed cells from newly completed forecasts", () => {
  const resources = createResourceCounters(["none", "frozen"]);
  Object.assign(resources.get("none")!, {
    cells: 1,
    reused: 2,
    failed: 1,
    inTok: 200,
    cost: 0.4,
    failedCost: 0.1,
    ms: 5000,
    modelMs: 3000,
    toolMs: 1000,
    budgetReachedOnFailed: 1,
  });
  const client: LlmClient = {
    id: "fixture",
    traceMetadata: { pricing: { usd_cost_known: true } },
    async complete() {
      throw new Error("Accounting must not call a model");
    },
  };
  const args = {
    columns: ["none"],
    resources,
    conditionsByArm: new Map(),
    maxToolCalls: 7,
    client,
  };
  const row = buildResourceRows(args)[0]!;
  assert.equal(row.reused, 2);
  assert.equal(row.meanInputTokens, 200);
  assert.equal(row.meanSeconds, 5);
  assert.equal(row.meanCostUsd, 0.4);
  assert.equal(row.totalCostUsd, 0.5);
  assert.equal(row.budgetEvaluatedCells, 2);
  assert.equal(row.budgetReachedRate, 0.5);
  assert.equal(resources.get("frozen")!.cells, 0);
  const unpriced = buildResourceRows({
    ...args,
    client: { ...client, traceMetadata: {} },
  })[0]!;
  assert.equal(unpriced.meanCostUsd, null);
  assert.equal(unpriced.totalCostUsd, null);
});
