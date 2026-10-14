/**
 * Golden identity for the July 2026 formal setting. The old path is a continuation job as the
 * controller approved it (explicit arguments under --profile custom); the new path names the
 * july-2026-formal preset plus an override file that swaps the shared-server paths for local fixtures.
 * Both must give byte-identical conditions for every arm. A separate file from the formal-232
 * case because search HTTP concurrency is fixed per process (32 here).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PKG_ROOT } from "../../paths.js";
import { formalArguments } from "../environment-check.js";
import { readForecastOptions } from "../forecast/options.js";
import {
  conditionsFor, formerSpelling, frozenIndexFixture, legacyOptions, placeholderCredentials, questionFixture, wikiFixture,
} from "./golden/harness.js";
import { legacyFormalArguments } from "./golden/legacy-733fec5.js";

const ANCHOR = "2026-07-01T00:00:00.000Z";

test("the july-2026-formal preset reproduces the approved July continuation conditions", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const dir = mkdtempSync(join(tmpdir(), "golden-july-"));
  const restore = placeholderCredentials();
  try {
    const { questions, grading } = questionFixture(join(dir, "bank"), ANCHOR);
    const index = await frozenIndexFixture(dir, ANCHOR);
    const wiki = wikiFixture(dir, ANCHOR);
    const local = {
      evidence: join(dir, "evidence"), frozenCache: join(dir, "frozen-cache.sqlite"), reviewCache: join(dir, "review-cache"),
    };
    const override = join(dir, "local-paths.json");
    writeFileSync(override, JSON.stringify({
      schema: "raven.run-config.v1",
      design: { questions_file: questions, grading_file: grading, frozen_corpus_file: index, wiki_manifest: wiki.manifest },
      efficiency: { shared_frozen_cache: local.frozenCache, frozen_global_slots: 4, shared_review_cache: local.reviewCache },
      paths: { wiki_cache: wiki.cache, retrieval_evidence_dir: local.evidence },
    }));
    for (const arm of ["none", "frozen", "web-filter", "both"]) {
      const web = arm === "web-filter" || arm === "both", frozen = arm === "frozen" || arm === "both";
      // tools/parallel-missing-continuation.py's approved arguments for this arm, plus the
      // paths and operating limits the September 17 plan passed.
      const approved = [
        "--profile", "custom", "--questions-file", questions, "--grading-file", grading, "--settings", arm,
        "--llm", "fixture:model", "--ledger", "0", "--max-tool-calls", "100", "--max-results-per-search", "20",
        "--fetch-chars", "0", "--retrieval-profile", "quality-v1", "--tool-delivery", "paged", "--n", "254",
        "--include-china-filtered", "1", "--search-provider", "serper", "--wiki-cache", wiki.cache,
        "--retrieval-evidence-dir", local.evidence, "--conc", "4",
        "--frozen-workers", "4", "--frozen-queue", "1280", "--candidate-concurrency", "8", "--review-concurrency", "128",
        "--search-concurrency", "32", "--fetch-concurrency", "96", "--reader-concurrency", "64", "--reader-rpm", "480",
        "--page-dispatch-concurrency", "128",
        ...(web ? ["--review-thinking", "enabled", "--review-effort", "low", "--leak-llm", "deepseek:deepseek-flash",
          "--search-delivery", "summary", "--shared-review-cache", local.reviewCache] : []),
        ...(frozen ? ["--frozen-search-delivery", "lead", "--frozen-corpus-file", index, "--wiki-manifest", wiki.manifest,
          "--shared-frozen-cache", local.frozenCache, "--frozen-global-slots", "4"] : []),
      ];
      const old = conditionsFor(legacyOptions(legacyFormalArguments(formerSpelling(approved), PKG_ROOT).args));
      const raw = ["--preset", "july-2026-formal", "--config", override, "--llm", "fixture:model", "--settings", arm, "--conc", "4"];
      const admitted = formalArguments(raw, PKG_ROOT);
      assert.equal(admitted.profile, "custom");
      assert.deepEqual(conditionsFor(readForecastOptions(admitted.args)), old, `${arm}: preset through the shared path`);
      assert.deepEqual(conditionsFor(readForecastOptions(raw)), old, `${arm}: preset through the direct runner`);
      // The explicit continuation arguments still admit and keep their conditions.
      assert.deepEqual(conditionsFor(readForecastOptions(formalArguments(approved, PKG_ROOT).args)), old, `${arm}: explicit job`);
      assert.deepEqual(conditionsFor(readForecastOptions(formalArguments(formerSpelling(approved), PKG_ROOT).args)), old, `${arm}: explicit job, former spelling`);
    }
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
