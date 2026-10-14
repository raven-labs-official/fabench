import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishBrierReport } from "./brier/publication.js";
import { buildBrierReport } from "./brier/report.js";

function emptyReport() {
  return buildBrierReport({ registry: { runs: [], canonicalCells: [], statusRows: [] },
    questions: [], registryPath: "fixture.sqlite", bootstrapIters: 1,
    policy: { schema_version: "fixture", minimum_expected_questions: 1,
      primary_coverage_threshold: 1, invalid_conditions: {}, diagnostic_conditions: {} },
  });
}

test("publication replaces absent, stale, and dangling temporary links", () => {
  for (const previous of ["absent", "file", "dangling"] as const) {
    const root = mkdtempSync(join(tmpdir(), "fabench-publish-link-"));
    try {
      const tempLink = join(root, `.current-${process.pid}`);
      if (previous === "file") writeFileSync(tempLink, "stale temporary entry");
      if (previous === "dangling") symlinkSync("missing", tempLink, "dir");
      const report = emptyReport();
      publishBrierReport(root, report);
      assert.deepEqual(JSON.parse(readFileSync(join(root, "current", "final-answer-table.json"), "utf8")), report.answerTable);
      const latest = JSON.parse(readFileSync(join(root, "latest.json"), "utf8"));
      assert.equal(readlinkSync(join(root, "current")), latest.current);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a directory at the temporary link path fails before switching current", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-publish-link-error-"));
  try {
    mkdirSync(join(root, "previous"));
    symlinkSync("previous", join(root, "current"), "dir");
    mkdirSync(join(root, `.current-${process.pid}`));
    assert.throws(() => publishBrierReport(root, emptyReport()), { code: "ERR_FS_EISDIR" });
    assert.equal(readlinkSync(join(root, "current")), "previous");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
