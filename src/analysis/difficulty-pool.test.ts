import assert from "node:assert/strict";
import test from "node:test";

import { isEmpiricalDifficultyAnswer } from "./difficulty-pool.js";

test("empirical difficulty includes primary and every Smoke answer", () => {
  assert.equal(
    isEmpiricalDifficultyAnswer({
      result_scope: "benchmark",
      publication_status: "primary",
      raw_brier: 0.1,
    }),
    true,
  );
  assert.equal(
    isEmpiricalDifficultyAnswer({
      result_scope: "smoke",
      publication_status: "smoke",
      raw_brier: 0.2,
    }),
    true,
  );
});

test("empirical difficulty excludes non-primary benchmark diagnostics", () => {
  for (const publicationStatus of [
    "running-partial",
    "diagnostic-only",
    "invalid",
    "superseded",
  ]) {
    assert.equal(
      isEmpiricalDifficultyAnswer({
        result_scope: "benchmark",
        publication_status: publicationStatus,
        raw_brier: 0.3,
      }),
      false,
    );
  }
});

