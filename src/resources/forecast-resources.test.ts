import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PKG_ROOT } from "../paths.js";
import { SYNTHETIC_GRADING, SYNTHETIC_QUESTIONS } from "../datasets/test-fixtures.js";
import { readForecastArms, readForecastOptions } from "../experiments/forecast/options.js";
import { loadForecastQuestions, loadProvidedEvidence } from "../experiments/forecast/questions.js";
import { createForecastRetrieval } from "../experiments/forecast/retrieval.js";
import { buildForecastRunConfig } from "../experiments/forecast/run-config.js";
import type { LlmClient } from "../llm/benchmark-client.js";
import { createRetrievalRuntime } from "../../vendor/retrieval-infra/src/api/runtime.js";

test("closed-book setup records absent review/expansion clients without creating unused resources", () => {
  const parent = join(PKG_ROOT, "results/resource-controls-20261002");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "closed-book-"));
  const options = readForecastOptions([
    "--preset", "custom", "--llm", "fixture:model", "--settings", "none", "--n", "1",
    "--questions-file", SYNTHETIC_QUESTIONS, "--grading-file", SYNTHETIC_GRADING,
    "--retrieval-evidence-dir", directory,
  ]);
  const client: LlmClient = { id: "fixture:model", complete: async () => {
    throw new Error("Setup must not make a model call");
  } };
  const dataset = loadForecastQuestions(options, { offline: true });
  const evidence = loadProvidedEvidence("");
  const arms = readForecastArms(options);
  const retrieval = createForecastRetrieval({
    options, arms, client, questions: dataset.questions,
    evidenceFile: "", providedEvidence: evidence.providedEvidence,
  });
  try {
    const { conditions, runConfig } = buildForecastRunConfig({
      options, arms, client, dataset, evidence, retrieval, evidenceFile: "",
    });
    assert.equal(retrieval.leakClient, undefined);
    assert.equal(retrieval.expandClient, undefined);
    assert.equal(runConfig.leakFilterClient, null);
    assert.equal(runConfig.queryExpansionClient, null);
    assert.equal(conditions[0]!.filter_model, null);
    assert.equal(conditions[0]!.query_expansion_model, null);
  } finally {
    retrieval.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cleaning concurrency configures a separate cleaner only in whole-document processing", () => {
  const parent = join(PKG_ROOT, "results/resource-controls-20261002");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "processing-modes-"));
  const client: LlmClient = { id: "fixture:model", complete: async () => {
    throw new Error("Runtime setup must not make a model call");
  } };
  try {
    for (const processing of ["single-pass", "integrated", "whole-document"] as const) {
      const runtime = createRetrievalRuntime({
        evidenceDirectory: join(directory, processing), reviewerClient: client,
        provider: { name: "fixture", search: async () => { throw new Error("Setup must not search"); } },
        reviewOptions: { processing, concurrency: 3 }, cleaningOptions: { concurrency: 2 },
      });
      try {
        assert.equal(Boolean(runtime.cleaner), processing === "whole-document");
        assert.equal(runtime.reviewer?.configuration().concurrency, 3);
        if (runtime.cleaner) assert.equal(runtime.cleaner.configuration().concurrency, 2);
      } finally { runtime.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the evidence ledger enters the condition only when it is on", () => {
  const parent = join(PKG_ROOT, "results/resource-controls-20261002");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "ledger-"));
  const client: LlmClient = { id: "fixture:model", complete: async () => {
    throw new Error("Setup must not make a model call");
  } };
  const condition = (ledger: string) => {
    const options = readForecastOptions([
      "--preset", "custom", "--llm", "fixture:model", "--settings", "none", "--n", "1", "--ledger", ledger,
      "--questions-file", SYNTHETIC_QUESTIONS, "--grading-file", SYNTHETIC_GRADING,
      "--retrieval-evidence-dir", directory,
    ]);
    const dataset = loadForecastQuestions(options, { offline: true }), evidence = loadProvidedEvidence(""), arms = readForecastArms(options);
    const retrieval = createForecastRetrieval({ options, arms, client, questions: dataset.questions,
      evidenceFile: "", providedEvidence: evidence.providedEvidence });
    try {
      return buildForecastRunConfig({ options, arms, client, dataset, evidence, retrieval, evidenceFile: "" }).conditions[0]!;
    } finally { retrieval.close(); }
  };
  try {
    const off = condition("0"), on = condition("1");
    assert.equal("ledger" in off, false);
    assert.equal(on.ledger, "on");
    assert.notEqual(on.condition_id, off.condition_id);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
