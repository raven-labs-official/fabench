import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commonQuestions, loadRun } from "./forecast-results.js";

test("result loading preserves missing forecasts and selects only consistently labelled shared questions", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "forecast-results-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runs = [
    [
      { question_id: "shared", outcome: 1, forecasts: { web: null } },
      { question_id: "conflict", outcome: 1, forecasts: { web: 0.5 } },
      { question_id: "only-first", outcome: 0, forecasts: { web: 0.4 } },
    ],
    [
      { question_id: "shared", outcome: 1, forecasts: { "web-filter": 0.8 } },
      { question_id: "conflict", outcome: 0, forecasts: { "web-filter": 0.5 } },
    ],
  ].map((perQuestion, index) => {
    const file = join(directory, `forecast-value-${index}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        config: { llm: `fixture:${index}`, maxSearches: 7 },
        perQuestion,
      }),
    );
    return loadRun(file);
  });
  assert.equal(runs[0]!.maxToolCalls, 7);
  assert.deepEqual(runs[0]!.byId.get("shared")!.forecasts, {
    "web-filter": null,
  });
  assert.deepEqual(commonQuestions(runs), {
    commonIds: ["shared"],
    conflicting: 1,
  });
});
