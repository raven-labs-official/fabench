import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TraceArchive,
  TRACE_DIRECTORY_MODE,
  TRACE_DURABILITY_POLICY,
  TRACE_FILE_MODE,
  verifyTraceArchive,
  verifyTraceFile,
  serializeError,
} from "./trace-archive.js";

test("error archives retain nested timeout causes and terminate cyclic chains", () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const failure = new Error("quality search provider unavailable", { cause: new Error("brave request failed (TimeoutError)", { cause: timeout }) });
  const archived = JSON.parse(JSON.stringify(serializeError(failure)));
  assert.equal(archived.cause.message, "brave request failed (TimeoutError)");
  assert.equal(archived.cause.cause.name, "TimeoutError");
  failure.cause = failure;
  assert.equal((serializeError(failure).cause as {message:string}).message, "[circular error cause]");
  let deep: Error = new Error("root");
  for (let i=0;i<20;i++) deep=new Error("wrapper",{cause:deep});
  assert.match(JSON.stringify(serializeError(deep)), /error cause depth limit/);
});

test("TraceArchive writes a durable hash-chained cell and completed manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-trace-"));
  const archive = new TraceArchive({
    resultsDir: root,
    tag: "unit",
    cwd: root,
    expectedCells: 1,
    run: { model: "fake:model", secret: "not-a-real-secret" },
  });
  const cell = archive.beginCell({
    question_id: "q/1",
    arm: "frozen",
    question: "Will it happen?",
    as_of: "2026-03-01T00:00:00Z",
  });
  cell.record({ type: "agent_started", data: { messages: [{ role: "user", content: "hi" }] } });
  cell.record({
    type: "tool_call_finished",
    data: { content: JSON.stringify({ text: "the exact document body" }) },
  });
  cell.finish("success", { probability: 0.37 });
  archive.finish("completed", { note: "done" });

  const rows = readFileSync(archive.cellsPath, "utf8").trim().split("\n");
  assert.equal(rows.length, 1);
  const row = JSON.parse(rows[0]!);
  assert.equal(row.status, "success");
  assert.equal(row.probability, 0.37);

  const trace = verifyTraceFile(join(archive.directory, row.trace_file));
  assert.deepEqual(trace.issues, []);
  assert.equal(trace.eventCount, 4);
  assert.equal(trace.complete, true);

  const verified = verifyTraceArchive(archive.directory);
  assert.deepEqual(verified.issues, []);
  assert.equal(verified.ok, true);
  assert.equal(verified.traces, 1);

  const manifest = JSON.parse(readFileSync(archive.manifestPath, "utf8"));
  assert.equal(manifest.status, "completed");
  assert.deepEqual(manifest.counts, {
    expected: 1,
    started: 1,
    succeeded: 1,
    failed: 0,
    interrupted: 0,
  });
  // Darwin may clear setgid on a directory created by an unprivileged test user; the server
  // deployment separately verifies 2750. The portable contract here is team read/traverse.
  assert.equal(statSync(archive.directory).mode & 0o777, TRACE_DIRECTORY_MODE & 0o777);
  assert.equal(statSync(archive.manifestPath).mode & 0o777, TRACE_FILE_MODE);
  assert.equal(statSync(join(archive.directory, row.trace_file)).mode & 0o777, TRACE_FILE_MODE);
});

test("TraceArchive records immutable release metadata when Git ownership is untrusted", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-release-trace-"));
  mkdirSync(join(root, ".git"));
  const commit = "b".repeat(40);
  writeFileSync(join(root, ".git", "raven-release-commit"), `${commit}\n`);
  const archive = new TraceArchive({ resultsDir: join(root, "results"), tag: "release", cwd: root });
  archive.finish("completed");

  const manifest = JSON.parse(readFileSync(archive.manifestPath, "utf8"));
  assert.equal(manifest.runtime.git.commit, commit);
  assert.equal(manifest.runtime.git.dirty, false);
});

test("TraceArchive indexes partial cells when a run is interrupted", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-trace-"));
  const archive = new TraceArchive({ resultsDir: root, tag: "partial", run: {} });
  const cell = archive.beginCell({
    question_id: "q2",
    arm: "none",
    question: "Question",
    as_of: "2026-03-01",
  });
  cell.record({ type: "model_attempt_started", data: { turn: 0 } });
  archive.finish("interrupted", { signal: "SIGINT" });

  const row = JSON.parse(readFileSync(archive.cellsPath, "utf8").trim());
  assert.equal(row.status, "interrupted");
  assert.equal(verifyTraceArchive(archive.directory).ok, true);
});

test("verification detects an edited event", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-trace-"));
  const archive = new TraceArchive({ resultsDir: root, tag: "tamper", run: {} });
  const cell = archive.beginCell({
    question_id: "q3",
    arm: "none",
    question: "Question",
    as_of: "2026-03-01",
  });
  cell.record({ type: "assistant_message", data: { content: "original answer" } });
  cell.finish("success", { probability: 0.5 });
  archive.finish("completed");
  const row = JSON.parse(readFileSync(archive.cellsPath, "utf8").trim());
  const path = join(archive.directory, row.trace_file);
  writeFileSync(path, readFileSync(path, "utf8").replace("original answer", "altered answer"));
  const verified = verifyTraceArchive(archive.directory);
  assert.equal(verified.ok, false);
  assert.ok(verified.issues.some((issue) => issue.includes("event hash does not match")));
});

test("TraceArchive stores identical page bodies once and verifies their content hash", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-trace-blob-"));
  const archive = new TraceArchive({ resultsDir: root, tag: "blob", run: {} });
  const cell = archive.beginCell({
    question_id: "q-blob",
    arm: "web-filter",
    question: "Question",
    as_of: "2026-03-01",
  });
  const first = cell.storeTextBlob("same full article body");
  const second = cell.storeTextBlob("same full article body");
  assert.deepEqual(second, first);
  assert.equal(readFileSync(join(archive.directory, first.path), "utf8"), "same full article body");
  cell.finish("success", { probability: 0.5 });
  archive.finish("completed");
  assert.equal(verifyTraceArchive(archive.directory).ok, true);
  const manifest = JSON.parse(readFileSync(archive.manifestPath, "utf8"));
  assert.equal(manifest.archive.blob_directory, "blobs");
});

test("cell events are written at once but flushed at most once per interval and always at finish", async () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-trace-flush-"));
  try {
    const flushes: number[] = [];
    const archive = new TraceArchive({ resultsDir: root, tag: "flush", run: {}, syncIntervalMs: 200, syncFile: fd => flushes.push(fd) });
    const cell = archive.beginCell({ question_id: "Q1", arm: "web-filter", question: "q", as_of: "2026-07-01T00:00:00Z" });
    for (let i = 0; i < 500; i++) cell.record({ type: "stage_timing", data: { i } });
    assert.equal(flushes.length, 1, "only the first event of the burst forces a flush");
    const lines = readFileSync(cell.path, "utf8").trim().split("\n");
    assert.equal(lines.length, 501, "every event is already in the file before any flush");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(flushes.length, 2, "the tail of the burst is flushed by the interval timer");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(flushes.length, 2, "an idle cell does not flush again");
    cell.finish("success");
    assert.equal(flushes.length, 3, "finishing always flushes");
    archive.finish("completed");
    const manifest = JSON.parse(readFileSync(archive.manifestPath, "utf8"));
    assert.deepEqual(manifest.archive.durability, { policy: TRACE_DURABILITY_POLICY, flush_interval_ms: 200 });
    assert.equal(verifyTraceArchive(archive.directory).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an interval of zero or an explicit event count keeps per-event and count-based flushing", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-trace-flush-count-"));
  try {
    for (const [options, expected] of [[{ syncIntervalMs: 0 }, 11], [{ syncEveryEvents: 4 }, 2]] as const) {
      const flushes: number[] = [];
      const archive = new TraceArchive({ resultsDir: root, tag: `count-${expected}`, run: {}, ...options, syncFile: fd => flushes.push(fd) });
      const cell = archive.beginCell({ question_id: "Q1", arm: "none", question: "q", as_of: "2026-07-01T00:00:00Z" });
      for (let i = 0; i < 10; i++) cell.record({ type: "tool", data: { i } });
      assert.equal(flushes.length, expected);
      cell.finish("success");
      archive.finish("completed");
      assert.equal(verifyTraceArchive(archive.directory).ok, true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
