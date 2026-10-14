import assert from "node:assert/strict";
import test from "node:test";
import type { RegistryRunRow } from "./registry.js";
import {
  buildFeishuMessage,
  estimateProgress,
  feishuSignature,
  formatDuration,
  formatProgressReport,
  type ProgressSnapshot,
} from "./progress-report.js";

function run(overrides: Partial<RegistryRunRow> = {}): RegistryRunRow {
  return {
    runId: "run-1",
    tag: "glm52-300-3arm-t50-c4",
    owner: "alice",
    host: "server",
    pid: 123,
    status: "running",
    storedStatus: "running",
    expectedCells: 900,
    claimedCells: 365,
    reusedCells: 124,
    succeededCells: 393,
    failedCells: 18,
    interruptedCells: 0,
    startedAtUtc: "2026-08-28T11:00:00.000Z",
    lastHeartbeatUtc: "2026-08-28T15:00:00.000Z",
    finishedAtUtc: null,
    traceDirectory: "/tmp/trace",
    config: {
      llm: "glm:glm-5.2",
      compare: "none,frozen,web-filter",
      selected_question_ids: Array.from({ length: 300 }, (_, index) => `q${index}`),
      conc: 4,
      maxToolCalls: 50,
      maxResultsPerSearch: 20,
      reasoning_mode: null,
      thinking_effort: null,
    },
    ...overrides,
  };
}

test("ETA excludes cells that were reused instantly", () => {
  const estimate = estimateProgress(run(), Date.parse("2026-08-28T15:00:00.000Z"));
  assert.equal(estimate.terminalCells, 535);
  assert.equal(estimate.progressPercent.toFixed(1), "59.4");
  assert.equal(formatDuration(estimate.elapsedMs), "4h");
  assert.equal(formatDuration(estimate.remainingMs), "3h 33m");
  assert.equal(formatDuration(estimate.totalMs), "7h 33m");
});

test('stale run has no ETA and elapsed time ends at its last heartbeat',()=>{
  const stale=run({status:'stale',expectedCells:60,reusedCells:0,succeededCells:0,failedCells:4,interruptedCells:0,
    startedAtUtc:'2026-09-09T04:50:11.226Z',lastHeartbeatUtc:'2026-09-09T04:52:08.640Z'});
  const estimate=estimateProgress(stale,Date.parse('2026-09-14T04:00:00Z'));
  assert.equal(estimate.remainingMs,null);assert.equal(estimate.etaUtc,null);assert.equal(estimate.elapsedMs,117414);
  const snapshot:ProgressSnapshot={generatedAtUtc:'2026-09-14T04:00:00Z',timeZone:'Asia/Shanghai',host:'server',load1:0,memoryAvailableBytes:0,memoryTotalBytes:0,dataDiskAvailableBytes:0,registeredRuns:[stale],unregisteredExperiments:[]};
  assert.match(formatProgressReport(snapshot),/Running experiments: 0 /);
  assert.match(JSON.stringify(buildFeishuMessage(snapshot)),/Stale records to handle: 1/);
  assert.doesNotMatch(JSON.stringify(buildFeishuMessage(snapshot)),/69d|11-23/);
});

test("report contains every requested human-facing field", () => {
  const snapshot: ProgressSnapshot = {
    generatedAtUtc: "2026-08-28T15:00:00.000Z",
    timeZone: "Asia/Shanghai",
    host: "server",
    load1: 1.1,
    memoryAvailableBytes: 26 * 1024 ** 3,
    memoryTotalBytes: 30 * 1024 ** 3,
    dataDiskAvailableBytes: 109 * 1024 ** 3,
    registeredRuns: [run()],
    unregisteredExperiments: [{
      owner: "bob",
      pid: 456,
      parentPid: 1,
      elapsedSeconds: 600,
      name: "opus5-frozen10",
      parameters: "model claude-opus-5 | questions 10 | conc 2",
      note: "not in the shared registry; completion count and ETA unknown",
    }],
  };
  const report = formatProgressReport(snapshot);
  for (const field of ["Running experiments", "Progress: ", "Main parameters: ", "Elapsed: ", "Estimated time: ", "Notes: "]) {
    assert.match(report, new RegExp(field));
  }
  assert.match(report, /535\/900 \(59\.4%\)/);
  assert.match(report, /unknown \(not in the shared registry\)/);
});

test("Feishu signature is deterministic", () => {
  const signature = feishuSignature(1599360473, "secret");
  assert.equal(signature, feishuSignature(1599360473, "secret"));
  assert.notEqual(signature, feishuSignature(1599360474, "secret"));
});

test("progress summaries retain valid runs and explicitly flag damaged configuration", () => {
  const snapshot: ProgressSnapshot = {
    generatedAtUtc: "2026-08-28T15:00:00.000Z",
    timeZone: "Asia/Shanghai",
    host: "server",
    load1: 0,
    memoryAvailableBytes: 0,
    memoryTotalBytes: 0,
    dataDiskAvailableBytes: 0,
    registeredRuns: [run(), run({ runId: "damaged", config: null, configError: "damaged config_json" })],
    unregisteredExperiments: [],
  };
  const report = formatProgressReport(snapshot);
  assert.match(report, /glm-5\.2/);
  assert.match(report, /config damaged/);
  const card = JSON.stringify(buildFeishuMessage(snapshot));
  assert.match(card, /glm-5\.2/);
  assert.match(card, /config unavailable/);
  assert.match(card, /config damaged/);
});

test("Feishu message is a readable interactive card with a summary table", () => {
  const snapshot: ProgressSnapshot = {
    generatedAtUtc: "2026-08-28T15:00:00.000Z",
    timeZone: "Asia/Shanghai",
    host: "server",
    load1: 1.1,
    memoryAvailableBytes: 26 * 1024 ** 3,
    memoryTotalBytes: 30 * 1024 ** 3,
    dataDiskAvailableBytes: 109 * 1024 ** 3,
    registeredRuns: [run()],
    unregisteredExperiments: [],
  };
  const message = buildFeishuMessage(snapshot);
  const serialized = JSON.stringify(message);
  assert.equal(message.msg_type, "interactive");
  assert.match(serialized, /FABench · Experiment progress/);
  assert.match(serialized, /column_set/);
  assert.match(serialized, /Run overview/);
  assert.match(serialized, /59\.4%/);
  assert.match(serialized, /Main parameters/);
  assert.match(serialized, /estimated total/);
  assert.doesNotMatch(serialized, /"msg_type":"text"/);
});
