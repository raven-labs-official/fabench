import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunResources } from "./resources.js";

test("legacy resources after the eighth summary remain visible and current summaries are resolved first", () => {
  const directory = mkdtempSync(join(tmpdir(), "fabench-dashboard-resources-"));
  const traceDirectory = join(directory, "traces", "run");
  mkdirSync(traceDirectory, { recursive: true });
  try {
    const rows = [{ arm: "none", totalCostUsd: 7.5, resourceScope: "fixture" }];
    for (let i = 0; i < 10; i++)
      writeFileSync(join(directory, `forecast-value-${i}.json`), JSON.stringify({ trace_run_id: i === 9 ? "run" : `other-${i}`, resources: i === 9 ? rows : [] }));
    let reads = 0;
    const read = (path:string) => { reads++; return readFileSync(path, "utf8"); };
    const run = { runId: "run", tag: "legacy", traceDirectory };
    assert.deepEqual(readRunResources(run, read), { status: "available", rows });
    assert.equal(reads, 10);
    writeFileSync(join(directory, "forecast-value-current.json"), JSON.stringify({ trace_run_id: "run", resources: rows }));
    reads = 0;
    assert.deepEqual(readRunResources({ ...run, tag: "current" }, read), { status: "available", rows });
    assert.equal(reads, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("missing, unreadable, malformed and explicitly empty resources have distinct meanings", () => {
  const directory = mkdtempSync(join(tmpdir(), "fabench-dashboard-resource-state-"));
  const run = { runId: "run", tag: "target", traceDirectory: join(directory, "traces", "run") };
  const path = join(directory, "forecast-value-target.json");
  const read = (file:string) => readFileSync(file, "utf8");
  try {
    assert.equal(readRunResources(run, read).status, "not_recorded");
    writeFileSync(path, JSON.stringify({ trace_run_id: "run", resources: [] }));
    assert.deepEqual(readRunResources(run, read), { status: "available", rows: [] });
    assert.equal(readRunResources(run, () => null).status, "unavailable");
    for (const value of ["{", "null", '{"trace_run_id":"run","resources":{}}', '{"trace_run_id":"run","resources":[null]}']) {
      writeFileSync(path, value);
      assert.equal(readRunResources(run, read).status, "invalid");
    }
    writeFileSync(path, JSON.stringify({ trace_run_id: "run" }));
    assert.equal(readRunResources(run, read).status, "not_recorded");
    writeFileSync(path, JSON.stringify({ trace_run_id: "other", resources: [{ totalCostUsd: 99 }] }));
    assert.equal(readRunResources(run, read).status, "not_recorded");
    rmSync(directory, { recursive: true });
    assert.equal(readRunResources(run, read).status, "not_recorded");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
