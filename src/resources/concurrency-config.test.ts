import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PKG_ROOT } from "../paths.js";
import { formalArguments } from "../experiments/environment-check.js";
import { readForecastOptions } from "../experiments/forecast/options.js";
import { readConcurrencyFile } from "./concurrency-config.js";

test("shared and direct entries apply one concurrency file, with explicit CLI overrides", () => {
  const file = join(PKG_ROOT, "config/concurrency.example.json");
  const args = ["--llm", "deepseek:deepseek-flash", "--settings", "none", "--concurrency-file", file, "--conc=7"];
  const admitted = formalArguments(args, PKG_ROOT);
  const options = readForecastOptions(args);
  assert.equal(admitted.selected.conc, "7");
  assert.equal(options.conc, 7);
  assert.equal(options.modelConcurrency, 4);
  assert.equal(options.qualityProfile.reviewConcurrency, 4);
  assert.equal(admitted.selected["review-concurrency"], "4");
  assert.equal(admitted.args.includes("--concurrency-file"), false);
});

test("a misspelled configuration or missing argument cannot silently select defaults", () => {
  const parent = join(PKG_ROOT, "results/resource-controls-20261002");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "config-test-"));
  const file = join(dir, "concurrency.json");
  try {
    writeFileSync(file, JSON.stringify({ schema: "raven.concurrency.v1", review_concurreny: 3 }));
    assert.throws(() => readConcurrencyFile(file), /Unknown concurrency setting/);
    assert.throws(() => readForecastOptions(["--concurrency-file", file]), /Unknown concurrency setting/);
    assert.throws(() => readForecastOptions(["--concurrency-file", file, "--concurrency-file", file]), /Duplicate argument --concurrency-file/);
    assert.throws(() => readForecastOptions(["--conc"]), /requires a value/);
    assert.throws(() => readForecastOptions(["--conc", "NaN"]), /positive safe integer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
