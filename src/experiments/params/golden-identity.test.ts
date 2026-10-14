/**
 * Golden identity: for the same effective settings the resolver must produce byte-identical
 * condition objects (and so condition_id) to the 733fec5 argument handling. Each case builds
 * conditions three ways: the old shared path (old admission, then the old parser), the new
 * shared path (new admission, then the runner) and the new direct runner.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PKG_ROOT } from "../../paths.js";
import { formalArguments } from "../environment-check.js";
import { readForecastOptions } from "../forecast/options.js";
import { conditionsFor, formerSpelling, frozenIndexFixture, legacyOptions, placeholderCredentials } from "./golden/harness.js";
import { legacyFormalArguments } from "./golden/legacy-733fec5.js";
import { needsFormalSet } from "../../datasets/test-fixtures.js";

const CURATED_QUESTIONS = join(PKG_ROOT, "question-making/curated/raven_model_test.jsonl");
const CURATED_GRADING = join(PKG_ROOT, "question-making/curated/raven_grading_key.jsonl");

test("formal-232 and custom conditions are byte-identical to the 733fec5 argument handling", { skip: needsFormalSet }, async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const dir = mkdtempSync(join(tmpdir(), "golden-identity-"));
  const restore = placeholderCredentials();
  try {
    const index = await frozenIndexFixture(dir, "2026-03-01T00:00:00.000Z");
    // Tests never touch the shared frozen cache: frozen arms name a private one.
    const local = (frozen: boolean) => ["--retrieval-evidence-dir", join(dir, "evidence"),
      ...(frozen ? ["--frozen-corpus-file", index, "--shared-frozen-cache", join(dir, "frozen-cache.sqlite"), "--frozen-global-slots", "4"] : [])];
    const base = ["--llm", "fixture:model", "--conc", "4"];
    const cases: [string, string[]][] = [
      ["none", [...base, "--settings", "none", ...local(false)]],
      ["frozen", [...base, "--settings", "frozen", ...local(true)]],
      ["web-filter", [...base, "--settings", "web-filter", "--leak-llm", "deepseek:deepseek-flash", ...local(false)]],
      ["both", [...base, "--settings", "both", "--leak-llm", "deepseek:deepseek-flash", ...local(true)]],
      ["all four formal arms", [...base, "--settings", "none,frozen,web-filter,both", "--leak-llm", "deepseek:deepseek-flash", ...local(true)]],
      ["custom ledger run", ["--profile", "custom", "--questions-file", CURATED_QUESTIONS, "--grading-file", CURATED_GRADING,
        ...base, "--settings", "none,frozen", "--ledger", "1", "--n", "5", ...local(true)]],
      ["concurrency file", [...base, "--settings", "none,frozen", "--concurrency-file", join(PKG_ROOT, "config/concurrency.example.json"),
        ...local(true)]],
      ["inline legacy delivery", ["--profile", "custom", "--questions-file", CURATED_QUESTIONS, "--grading-file", CURATED_GRADING,
        ...base, "--settings", "frozen", "--tool-delivery", "inline", "--n", "4", ...local(true)]],
    ];
    for (const [name, raw] of cases) {
      // The 733fec5 parser knows only the former spelling --compare.
      const old = conditionsFor(legacyOptions(legacyFormalArguments(formerSpelling(raw), PKG_ROOT).args));
      const admitted = formalArguments(raw, PKG_ROOT);
      assert.deepEqual(conditionsFor(readForecastOptions(admitted.args)), old, `${name}: shared path`);
      assert.deepEqual(conditionsFor(readForecastOptions(raw)), old, `${name}: direct runner`);
      assert.deepEqual(conditionsFor(readForecastOptions(formerSpelling(raw))), old, `${name}: former spelling --compare`);
    }

    // A direct run of arguments the old direct parser read the same way keeps its condition.
    const direct = ["--profile", "custom", "--questions-file", CURATED_QUESTIONS, "--grading-file", CURATED_GRADING,
      ...base, "--settings", "none,frozen", "--ledger", "1", "--n", "5", ...local(true)];
    assert.deepEqual(conditionsFor(readForecastOptions(direct)), conditionsFor(legacyOptions(formerSpelling(direct))));

    // A direct web-filter run used to skip the shared reviewer default; it now matches the
    // shared run, so only the reviewer effort (and hence condition_id) differs from before.
    const web = ["--profile", "custom", "--questions-file", CURATED_QUESTIONS, "--grading-file", CURATED_GRADING,
      ...base, "--settings", "web-filter", "--n", "3", ...local(false)];
    const [before] = conditionsFor(legacyOptions(formerSpelling(web))), [after] = conditionsFor(readForecastOptions(web));
    const changed = Object.keys(after!).filter((key) =>
      JSON.stringify((after as Record<string, unknown>)[key]) !== JSON.stringify((before as Record<string, unknown>)[key]));
    assert.deepEqual(changed.sort(), ["condition_id", "filter_policy", "filter_reasoning"]);
    assert.equal(after!.filter_reasoning?.thinking_effort, "low");
    assert.deepEqual([after], conditionsFor(readForecastOptions(formalArguments(web, PKG_ROOT).args)));

    // The legacy `web` alias is now read as web-filter on both paths, reviewer default included,
    // so its condition equals web-filter's and no longer matches the old `web` admission.
    const alias = web.map((v) => (v === "web-filter" ? "web" : v));
    const [oldAlias] = conditionsFor(legacyOptions(legacyFormalArguments(formerSpelling(alias), PKG_ROOT).args));
    assert.deepEqual(oldAlias, before, "733fec5 admitted `web` without the reviewer default");
    assert.deepEqual(conditionsFor(readForecastOptions(formalArguments(alias, PKG_ROOT).args)), [after]);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
