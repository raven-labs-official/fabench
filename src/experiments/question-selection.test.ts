import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PKG_ROOT } from "../paths.js";
import { formalQuestionIds, needsFormalSet } from "../datasets/test-fixtures.js";
import { formalArguments } from "./environment-check.js";
import { readForecastOptions } from "./forecast/options.js";
import { loadForecastQuestions } from "./forecast/questions.js";
import { normalizeQuestionId, selectedQuestionIds } from "./question-selection.js";
import { clearProjectEnv, projectEnv } from "../env-names.js";

const formal = ["--llm", "bailian:qwen3.8-flash", "--settings", "none", "--conc", "1"];

test("only an omitted subset uses default selection", () => {
  assert.equal(selectedQuestionIds(undefined, undefined), undefined);
  for (const value of ["", " ", ", ,"])
    assert.throws(() => selectedQuestionIds(value, undefined), /selects no questions/);
  assert.deepEqual(selectedQuestionIds("Q001, braven::Q041", undefined), ["Q001", "braven::Q041"]);
  assert.equal(normalizeQuestionId("BRAVEN::Q001"), "q001");
});

test("admission and runner reject empty subset files before selecting a bank", { skip: needsFormalSet }, () => {
  const directory = mkdtempSync(join(tmpdir(), "fabench-selection-empty-"));
  const file = join(directory, "ids.txt"), previous = process.argv;
  try {
    for (const content of ["", " \n\t", "# No missing questions\n\n"]) {
      writeFileSync(file, content);
      assert.throws(() => formalArguments([...formal, "--ids-file", file], PKG_ROOT), /selects no questions/);
      process.argv = [process.execPath, "offline", "--ids-file", file];
      assert.throws(() => readForecastOptions(), /selects no questions/);
    }
    assert.throws(() => formalArguments([...formal, "--ids", ""], PKG_ROOT), /selects no questions/);
  } finally {
    process.argv = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a commented subset uses the same IDs in formal admission and actual question loading", { skip: needsFormalSet }, () => {
  const directory = mkdtempSync(join(tmpdir(), "fabench-selection-formal-"));
  const file = join(directory, "ids.txt"), previous = process.argv;
  const lifecycle = projectEnv("FABENCH_SHARED_LIFECYCLE");
  try {
    const [first, second] = formalQuestionIds();
    writeFileSync(file, `# Reviewed subset\r\nBRAVEN::${first}, ${second}\r\n`);
    const admitted = formalArguments([...formal, "--ids-file", file], PKG_ROOT);
    process.env.FABENCH_SHARED_LIFECYCLE = "0";
    process.argv = [process.execPath, "offline", ...admitted.args, "--condition-preview-file", join(directory, "preview.json")];
    const options = readForecastOptions();
    assert.deepEqual(options.idSelection, [`BRAVEN::${first}`, second]);
    assert.deepEqual(loadForecastQuestions(options).questions.map(q => normalizeQuestionId(q.question_id)).sort(),
      [normalizeQuestionId(first!), normalizeQuestionId(second!)].sort());
    writeFileSync(file, `${first},not-a-question`);
    assert.throws(() => formalArguments([...formal, "--ids-file", file], PKG_ROOT), /outside the formal/);
  } finally {
    process.argv = previous;
    if (lifecycle === undefined) clearProjectEnv("FABENCH_SHARED_LIFECYCLE");
    else process.env.FABENCH_SHARED_LIFECYCLE = lifecycle;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("subset sources cannot be ambiguous or unreadable", () => {
  assert.throws(() => selectedQuestionIds("Q001", "/missing"), /either --ids/);
  assert.throws(() => selectedQuestionIds(undefined, ""), /requires a file path/);
  assert.throws(() => selectedQuestionIds(undefined, "/does-not-exist/fabench-subset.txt"), /Cannot read --ids-file/);
});
