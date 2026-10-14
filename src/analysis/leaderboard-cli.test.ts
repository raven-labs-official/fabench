import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("analysis example scores the supplied records and writes only the selected output", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fabench-analysis-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "selected output");
  const defaultOutput = join(directory, "default output");
  const child = spawnSync(process.execPath, ["--import", "tsx", resolve("src/analysis/leaderboard.ts"),
    resolve("examples/analysis/forecast-value-example-a.json"),
    resolve("examples/analysis/forecast-value-example-b.json"), "--output-dir", output], {
    env: { ...process.env, FABENCH_PATHS_CONFIG: "", FABENCH_RESULTS_DIR: defaultOutput },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(readFileSync(join(output, "leaderboard.json"), "utf8"));
  assert.equal(report.commonQuestions, 4);
  assert.equal(report.boards[0].arm, "none");
  const [a, b] = report.boards[0].entries;
  assert.ok(Math.abs(a.brier.point - 0.0825) < 1e-12);
  assert.ok(Math.abs(a.brierIndex.point - 100 * (1 - Math.sqrt(0.0825))) < 1e-10);
  assert.equal(b.brier.point, 0.25);
  assert.equal(b.brierIndex.point, 50);
  assert.equal(existsSync(defaultOutput), false);
  const brokenConfig = spawnSync(process.execPath, ["--import", "tsx", resolve("src/analysis/leaderboard.ts"),
    resolve("examples/analysis/forecast-value-example-a.json"), "--output-dir", output], {
    env: { ...process.env, FABENCH_PATHS_CONFIG: join(directory, "missing-config.json"), FABENCH_RESULTS_DIR: "" },
    encoding: "utf8",
  });
  assert.equal(brokenConfig.status, 0, brokenConfig.stderr);
  const defaultConfig = spawnSync(process.execPath, ["--import", "tsx", resolve("src/analysis/leaderboard.ts"),
    resolve("examples/analysis/forecast-value-example-a.json")], {
    env: { ...process.env, FABENCH_PATHS_CONFIG: "", FABENCH_RESULTS_DIR: defaultOutput },
    encoding: "utf8",
  });
  assert.equal(defaultConfig.status, 0, defaultConfig.stderr);
  assert.equal(JSON.parse(readFileSync(join(defaultOutput, "leaderboard.json"), "utf8")).commonQuestions, 4);
});
