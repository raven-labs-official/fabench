/**
 * Durable, append-only archives for one benchmark run.
 *
 * A score file is a summary, not an audit trail.  This module keeps one event stream per
 * (question, arm), writes each event before the agent proceeds, and hash-chains the stream so
 * truncation or accidental editing is detectable later.  The run manifest and cell index are
 * separate small files, making a half-finished run inspectable even after a crash.
 *
 * Trace directories are internal-team-readable by default (2750, files 0640). Tool results
 * can contain full article text and provider reasoning: team members may inspect them,
 * but they remain closed to non-team system users and must be sanitised before public release.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  fdatasyncSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { hostname, userInfo } from "node:os";
import { codeCommit, gitOutput, releaseCommit } from "../code-version.js";

export const TRACE_SCHEMA_VERSION = "raven.agent-trace.v1";
export const TRACE_MANIFEST_VERSION = "raven.trace-archive.v2";
const LEGACY_TRACE_MANIFEST_VERSION = "raven.trace-archive.v1";
export const TRACE_DIRECTORY_MODE = 0o2750;
export const TRACE_FILE_MODE = 0o640;

export interface TraceEventInput {
  type: string;
  data?: unknown;
}

/** The small seam used by an agent; the archive owns framing, timestamps and integrity. */
export interface AgentTraceSink {
  record(event: TraceEventInput): void;
  /**
   * Store large text once per run and return a content-addressed reference. Retrieval audits
   * use this for page bodies so the same URL/body found by many queries is not duplicated in
   * every cell event. The reference, not the body, belongs in the JSONL stream.
   */
  storeTextBlob?(text: string): TraceTextBlobRef;
}

export interface TraceTextBlobRef {
  sha256: string;
  path: string;
  bytes: number;
  chars: number;
  encoding: "utf-8";
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

export function serializeError(error: unknown): SerializedError {
  const seen = new Set<Error>();
  function visit(value: unknown, depth: number): SerializedError {
    if (!(value instanceof Error)) return { name: "NonErrorThrown", message: String(value) };
    if (seen.has(value)) return { name: value.name || "Error", message: "[circular error cause]" };
    if (depth >= 8) return { name: value.name || "Error", message: "[error cause depth limit]" };
    seen.add(value);
    // Error.message/name/stack are non-enumerable: JSON.stringify(cause) erased
    // the actual Brave/network error and left only the outer pipeline failure.
    return {
      name: value.name || "Error",
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
      ...(value.cause !== undefined ? { cause: value.cause instanceof Error ? visit(value.cause, depth + 1) : jsonSafe(value.cause) } : {}),
    };
  }
  return visit(error, 0);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function safeSegment(value: string, max = 48): string {
  const clean = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return clean || "unnamed";
}

function writeAll(fd: number, line: string): void {
  const buf = Buffer.from(line, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    const written = writeSync(fd, buf, offset, buf.length - offset);
    if (written <= 0) throw new Error("trace write made no progress");
    offset += written;
  }
}

/** Write a small JSON file without ever exposing a half-written replacement. */
function atomicJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const fd = openSync(tmp, "wx", TRACE_FILE_MODE);
  try {
    writeAll(fd, `${JSON.stringify(value, null, 2)}\n`);
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
    // Durably persist the directory entry as well as the file contents. Without this fsync an
    // acknowledged rename can disappear after a host power loss on some filesystems.
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw error;
  }
}

function runtimeProvenance(cwd: string): Record<string, unknown> {
  const commit = codeCommit(cwd);
  const immutableRelease = releaseCommit(cwd) != null;
  const status = immutableRelease ? "" : gitOutput(cwd, ["status", "--porcelain"]);
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    user: process.env.USER?.trim() || userInfo().username,
    host: hostname(),
    pid: process.pid,
    cwd,
    argv: process.argv.map(redactCliToken),
    git: {
      commit,
      dirty: status == null ? null : status.length > 0,
    },
  };
}

function redactCliToken(token: string, index: number, argv: string[]): string {
  if (index > 0 && /(?:key|token|secret|password|credential)/i.test(argv[index - 1] ?? ""))
    return "[REDACTED]";
  return token
    .replace(
      /((?:^--?[^=]*(?:key|token|secret|password|credential)[^=]*=))[^\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:api_?key|token|secret|password)=)[^&\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED]@");
}

interface TraceManifest {
  schema_version: typeof TRACE_MANIFEST_VERSION;
  run_id: string;
  tag: string;
  status: "running" | "completed" | "failed" | "interrupted";
  started_at_utc: string;
  updated_at_utc: string;
  finished_at_utc?: string;
  archive: {
    directory: string;
    cells_index: string;
    cell_event_directory: string;
    blob_directory: string;
    cells_index_final_sha256: string | null;
    /** How cell events reach the disk; absent in archives written before 2026-09-17. */
    durability?: Record<string, unknown>;
  };
  counts: {
    expected: number | null;
    started: number;
    succeeded: number;
    failed: number;
    interrupted: number;
  };
  runtime: Record<string, unknown>;
  run: Record<string, unknown>;
  completion?: unknown;
  manifest_sha256?: string;
}

export interface TraceArchiveOptions {
  /** Supplied by the shared experiment registry so one id joins registry, logs and traces. */
  runId?: string;
  resultsDir: string;
  tag: string;
  cwd?: string;
  expectedCells?: number;
  /** Dataset, model and protocol configuration. Secrets must not be put here. */
  run: Record<string, unknown>;
  /**
   * Legacy count-based durability: force the cell file to disk after this many events. When
   * set it replaces the interval policy below.
   */
  syncEveryEvents?: number;
  /**
   * Every event is written to its cell file immediately, so a process crash loses nothing
   * already recorded. Forcing the data to disk costs about 1.5 ms per call on the shared
   * data volume and ran on the main thread for each of ~10,000 events per question, so it
   * now happens at most once per interval per cell, and always when the cell finishes. A
   * host power loss can lose at most this interval. Default 1000 ms; 0 syncs every event.
   */
  syncIntervalMs?: number;
  /** Test seam for the disk flush; defaults to fdatasync. */
  syncFile?: (fd: number) => void;
}

export const TRACE_DURABILITY_POLICY = "write-each-event-flush-interval-v1";

export interface CellMetadata {
  question_id: string;
  arm: string;
  question: string;
  as_of: string;
  [key: string]: unknown;
}

export class TraceArchive {
  readonly runId: string;
  readonly directory: string;
  readonly cellsPath: string;
  readonly manifestPath: string;
  private readonly cellsDir: string;
  private readonly blobsDir: string;
  private readonly cellsFd: number;
  private readonly syncEveryEvents: number | undefined;
  private readonly syncIntervalMs: number;
  private readonly syncFile: (fd: number) => void;
  private readonly openRecorders = new Set<CellTraceRecorder>();
  private finalSummaryHash: string | null = null;
  private closed = false;
  private manifest: TraceManifest;

  constructor(options: TraceArchiveOptions) {
    this.runId = options.runId ?? randomUUID();
    const started = new Date().toISOString();
    const stamp = started.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const dirname = `${safeSegment(options.tag)}-${stamp}-${this.runId.slice(0, 8)}`;
    const tracesRoot = join(options.resultsDir, "traces");
    mkdirSync(tracesRoot, { recursive: true, mode: TRACE_DIRECTORY_MODE });
    chmodSync(tracesRoot, TRACE_DIRECTORY_MODE);
    this.directory = join(tracesRoot, dirname);
    if (existsSync(this.directory)) throw new Error(`trace archive already exists: ${this.directory}`);
    mkdirSync(this.directory, { mode: TRACE_DIRECTORY_MODE });
    this.cellsDir = join(this.directory, "cells");
    mkdirSync(this.cellsDir, { mode: TRACE_DIRECTORY_MODE });
    this.blobsDir = join(this.directory, "blobs");
    mkdirSync(this.blobsDir, { mode: TRACE_DIRECTORY_MODE });
    this.cellsPath = join(this.directory, "cells.jsonl");
    this.manifestPath = join(this.directory, "manifest.json");
    this.cellsFd = openSync(this.cellsPath, "wx", TRACE_FILE_MODE);
    this.syncEveryEvents = options.syncEveryEvents === undefined ? undefined : Math.max(1, options.syncEveryEvents);
    this.syncIntervalMs = Math.max(0, options.syncIntervalMs ?? 1000);
    this.syncFile = options.syncFile ?? fdatasyncSync;
    const cwd = options.cwd ?? process.cwd();
    this.manifest = {
      schema_version: TRACE_MANIFEST_VERSION,
      run_id: this.runId,
      tag: options.tag,
      status: "running",
      started_at_utc: started,
      updated_at_utc: started,
      archive: {
        directory: basename(this.directory),
        cells_index: "cells.jsonl",
        cell_event_directory: "cells",
        blob_directory: "blobs",
        cells_index_final_sha256: null,
        durability: this.syncEveryEvents === undefined
          ? { policy: TRACE_DURABILITY_POLICY, flush_interval_ms: this.syncIntervalMs }
          : { policy: "flush-every-n-events-v1", flush_every_events: this.syncEveryEvents },
      },
      counts: {
        expected: options.expectedCells ?? null,
        started: 0,
        succeeded: 0,
        failed: 0,
        interrupted: 0,
      },
      runtime: runtimeProvenance(cwd),
      run: jsonSafe(options.run) as Record<string, unknown>,
    };
    this.writeManifest();
  }

  /** Content-addressed, immutable page-body storage shared by every cell in this run. */
  storeTextBlob(text: string): TraceTextBlobRef {
    if (this.closed) throw new Error("cannot store a blob on a closed trace archive");
    const bytes = Buffer.from(text, "utf8");
    const digest = sha256(bytes);
    const filename = `${digest}.txt`;
    const path = join(this.blobsDir, filename);
    try {
      const fd = openSync(path, "wx", TRACE_FILE_MODE);
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (written <= 0) throw new Error("blob write made no progress");
          offset += written;
        }
        fdatasyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const dirFd = openSync(this.blobsDir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
    return {
      sha256: digest,
      path: join("blobs", filename),
      bytes: bytes.length,
      chars: text.length,
      encoding: "utf-8",
    };
  }

  beginCell(metadata: CellMetadata): CellTraceRecorder {
    if (this.closed) throw new Error("cannot begin a cell on a closed trace archive");
    const identity = sha256(`${metadata.question_id}\0${metadata.arm}`).slice(0, 12);
    const filename = `${safeSegment(metadata.question_id)}--${safeSegment(metadata.arm, 24)}--${identity}.jsonl`;
    const path = join(this.cellsDir, filename);
    const recorder = new CellTraceRecorder(this, path, metadata, {
      everyEvents: this.syncEveryEvents,
      intervalMs: this.syncIntervalMs,
      syncFile: this.syncFile,
    });
    this.openRecorders.add(recorder);
    this.manifest.counts.started++;
    this.writeManifest();
    return recorder;
  }

  /** Called only by CellTraceRecorder after its fd has been durably closed. */
  completeCell(
    recorder: CellTraceRecorder,
    status: "success" | "failed" | "interrupted",
    summary: Record<string, unknown>,
  ): void {
    this.openRecorders.delete(recorder);
    const base = {
      ...recorder.metadata,
      ...jsonSafe(summary) as Record<string, unknown>,
      schema_version: TRACE_MANIFEST_VERSION,
      run_id: this.runId,
      status,
      trace_file: relative(this.directory, recorder.path),
      trace_event_count: recorder.eventCount,
      trace_final_sha256: recorder.finalHash,
      previous_summary_sha256: this.finalSummaryHash,
    };
    const row = { ...base, summary_sha256: sha256Json(base) };
    writeAll(this.cellsFd, `${JSON.stringify(row)}\n`);
    fdatasyncSync(this.cellsFd);
    this.finalSummaryHash = row.summary_sha256;
    this.manifest.archive.cells_index_final_sha256 = this.finalSummaryHash;
    if (status === "success") this.manifest.counts.succeeded++;
    else if (status === "failed") this.manifest.counts.failed++;
    else this.manifest.counts.interrupted++;
    this.writeManifest();
  }

  finish(
    status: "completed" | "failed" | "interrupted",
    completion?: unknown,
  ): void {
    if (this.closed) return;
    // A graceful run should have finished every cell.  On SIGINT or an unexpected top-level
    // error, close the partial streams explicitly so their last durable hash is indexed too.
    for (const recorder of [...this.openRecorders]) {
      recorder.finish("interrupted", {
        error: {
          name: "RunInterrupted",
          message: `run closed while cell was active (${status})`,
        },
      });
    }
    this.manifest.status = status;
    this.manifest.finished_at_utc = new Date().toISOString();
    this.manifest.updated_at_utc = this.manifest.finished_at_utc;
    if (completion !== undefined) this.manifest.completion = jsonSafe(completion);
    this.writeManifest();
    fdatasyncSync(this.cellsFd);
    closeSync(this.cellsFd);
    this.closed = true;
  }

  private writeManifest(): void {
    this.manifest.updated_at_utc = new Date().toISOString();
    const withoutHash = { ...this.manifest };
    delete withoutHash.manifest_sha256;
    this.manifest.manifest_sha256 = sha256Json(withoutHash);
    atomicJson(this.manifestPath, this.manifest);
  }
}

export class CellTraceRecorder implements AgentTraceSink {
  readonly metadata: CellMetadata;
  readonly path: string;
  eventCount = 0;
  finalHash: string | null = null;
  private readonly fd: number;
  private readonly started = performance.now();
  private closed = false;
  private dirty = false;
  private lastSyncMs = Number.NEGATIVE_INFINITY;
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly archive: TraceArchive,
    path: string,
    metadata: CellMetadata,
    private readonly durability: { everyEvents?: number; intervalMs: number; syncFile: (fd: number) => void },
  ) {
    this.path = path;
    this.metadata = { ...metadata };
    this.fd = openSync(path, "wx", TRACE_FILE_MODE);
    this.record({ type: "cell_started", data: metadata });
  }

  record(input: TraceEventInput): void {
    if (this.closed) throw new Error(`cannot write to finished trace ${this.path}`);
    const base = {
      schema_version: TRACE_SCHEMA_VERSION,
      sequence: this.eventCount,
      timestamp_utc: new Date().toISOString(),
      elapsed_ms: Math.round(performance.now() - this.started),
      type: input.type,
      data: jsonSafe(input.data ?? null),
      previous_event_sha256: this.finalHash,
    };
    const eventHash = sha256Json(base);
    writeAll(this.fd, `${JSON.stringify({ ...base, event_sha256: eventHash })}\n`);
    this.eventCount++;
    this.finalHash = eventHash;
    this.dirty = true;
    const { everyEvents, intervalMs } = this.durability;
    if (everyEvents !== undefined) {
      if (this.eventCount % everyEvents === 0) this.sync();
      return;
    }
    const since = performance.now() - this.lastSyncMs;
    if (since >= intervalMs) this.sync();
    else if (!this.flushTimer) {
      // Flush the tail of a burst even if the cell then waits minutes for a tool.
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        if (!this.closed && this.dirty) this.sync();
      }, intervalMs - since);
      this.flushTimer.unref();
    }
  }

  private sync(): void {
    this.durability.syncFile(this.fd);
    this.dirty = false;
    this.lastSyncMs = performance.now();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  storeTextBlob(text: string): TraceTextBlobRef {
    return this.archive.storeTextBlob(text);
  }

  finish(
    status: "success" | "failed" | "interrupted",
    summary: Record<string, unknown> = {},
  ): void {
    if (this.closed) return;
    this.record({
      type: "cell_finished",
      data: { status, ...summary },
    });
    // The finishing event may already have flushed; otherwise flush now, before the index row.
    if (this.dirty) this.sync();
    closeSync(this.fd);
    this.closed = true;
    this.archive.completeCell(this, status, summary);
  }
}

export interface TraceVerification {
  ok: boolean;
  eventCount: number;
  finalHash: string | null;
  complete: boolean;
  issues: string[];
}

/** Verify JSON framing, sequence numbers and the per-cell SHA-256 chain. */
export function verifyTraceFile(path: string): TraceVerification {
  const issues: string[] = [];
  let previous: string | null = null;
  let eventCount = 0;
  let complete = false;
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [lineIndex, line] of lines.entries()) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      issues.push(`line ${lineIndex + 1}: invalid JSON (${serializeError(error).message})`);
      continue;
    }
    const claimed = typeof event.event_sha256 === "string" ? event.event_sha256 : null;
    const base = { ...event };
    delete base.event_sha256;
    if (event.sequence !== eventCount)
      issues.push(`line ${lineIndex + 1}: sequence ${String(event.sequence)} != ${eventCount}`);
    if (event.schema_version !== TRACE_SCHEMA_VERSION)
      issues.push(`line ${lineIndex + 1}: unsupported schema ${String(event.schema_version)}`);
    if (event.previous_event_sha256 !== previous)
      issues.push(`line ${lineIndex + 1}: previous hash does not match`);
    const actual = sha256Json(base);
    if (claimed !== actual) issues.push(`line ${lineIndex + 1}: event hash does not match`);
    previous = claimed ?? actual;
    eventCount++;
    if (event.type === "cell_finished") complete = true;
  }
  return { ok: issues.length === 0, eventCount, finalHash: previous, complete, issues };
}

export interface ArchiveVerification {
  ok: boolean;
  traces: number;
  completeTraces: number;
  issues: string[];
}

/** Verify every trace present on disk, including a partial trace not yet in cells.jsonl. */
export function verifyTraceArchive(directory: string): ArchiveVerification {
  const issues: string[] = [];
  const manifestPath = join(directory, "manifest.json");
  let manifest: Record<string, unknown> | undefined;
  if (!existsSync(manifestPath)) issues.push("manifest.json is missing");
  else {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const claimed = manifest.manifest_sha256;
      const base = { ...manifest };
      delete base.manifest_sha256;
      if (claimed !== sha256Json(base)) issues.push("manifest hash does not match");
      if (
        manifest.schema_version !== TRACE_MANIFEST_VERSION &&
        manifest.schema_version !== LEGACY_TRACE_MANIFEST_VERSION
      )
        issues.push(`unsupported manifest schema: ${String(manifest.schema_version)}`);
    } catch (error) {
      issues.push(`manifest.json is invalid: ${serializeError(error).message}`);
    }
  }

  const index = new Map<string, Record<string, unknown>>();
  const indexedStatuses = { success: 0, failed: 0, interrupted: 0 };
  let previousSummaryHash: string | null = null;
  const indexPath = join(directory, "cells.jsonl");
  if (!existsSync(indexPath)) issues.push("cells.jsonl is missing");
  else {
    for (const [i, line] of readFileSync(indexPath, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const claimed = row.summary_sha256;
        const base = { ...row };
        delete base.summary_sha256;
        if (claimed !== sha256Json(base)) issues.push(`cells.jsonl line ${i + 1}: hash mismatch`);
        if (row.previous_summary_sha256 !== previousSummaryHash)
          issues.push(`cells.jsonl line ${i + 1}: previous summary hash does not match`);
        previousSummaryHash = typeof claimed === "string" ? claimed : sha256Json(base);
        if (typeof row.trace_file === "string") {
          if (index.has(row.trace_file))
            issues.push(`cells.jsonl line ${i + 1}: duplicate trace_file ${row.trace_file}`);
          index.set(row.trace_file, row);
        }
        const status = row.status;
        if (status === "success" || status === "failed" || status === "interrupted")
          indexedStatuses[status]++;
        else issues.push(`cells.jsonl line ${i + 1}: invalid status ${String(status)}`);
      } catch (error) {
        issues.push(`cells.jsonl line ${i + 1}: invalid JSON (${serializeError(error).message})`);
      }
    }
  }

  const cellsDir = join(directory, "cells");
  let traces = 0;
  let completeTraces = 0;
  if (!existsSync(cellsDir) || !statSync(cellsDir).isDirectory()) issues.push("cells/ is missing");
  else {
    for (const name of readdirSync(cellsDir).filter((n) => n.endsWith(".jsonl"))) {
      traces++;
      const rel = join("cells", name);
      const result = verifyTraceFile(join(cellsDir, name));
      if (result.complete) completeTraces++;
      for (const issue of result.issues) issues.push(`${rel}: ${issue}`);
      const row = index.get(rel);
      if (row) {
        if (row.trace_event_count !== result.eventCount)
          issues.push(`${rel}: index event count does not match`);
        if (row.trace_final_sha256 !== result.finalHash)
          issues.push(`${rel}: index final hash does not match`);
      } else if (result.complete || manifest?.status !== "running") {
        issues.push(`${rel}: trace is absent from cells.jsonl`);
      }
    }
  }

  const blobsDir = join(directory, "blobs");
  if (
    manifest?.schema_version === TRACE_MANIFEST_VERSION &&
    (!existsSync(blobsDir) || !statSync(blobsDir).isDirectory())
  ) {
    issues.push("blobs/ is missing");
  } else if (existsSync(blobsDir) && statSync(blobsDir).isDirectory()) {
    for (const name of readdirSync(blobsDir).filter((n) => n.endsWith(".txt"))) {
      const claimed = name.slice(0, -4);
      const actual = sha256(readFileSync(join(blobsDir, name)));
      if (!/^[0-9a-f]{64}$/.test(claimed))
        issues.push(`blobs/${name}: filename is not a SHA-256 digest`);
      else if (claimed !== actual)
        issues.push(`blobs/${name}: content hash does not match filename`);
    }
  }
  const manualReviewPath = join(directory, "manual-reviews.jsonl");
  if (existsSync(manualReviewPath)) {
    let previousReviewHash: string | null = null;
    for (const [index, line] of readFileSync(manualReviewPath, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const claimed = typeof row.review_sha256 === "string" ? row.review_sha256 : null;
        const base = { ...row };
        delete base.review_sha256;
        if (row.sequence !== index)
          issues.push(`manual-reviews.jsonl line ${index + 1}: sequence mismatch`);
        if (row.previous_review_sha256 !== previousReviewHash)
          issues.push(`manual-reviews.jsonl line ${index + 1}: previous hash mismatch`);
        if (claimed !== sha256Json(base))
          issues.push(`manual-reviews.jsonl line ${index + 1}: hash mismatch`);
        if (
          typeof row.body_sha256 !== "string" ||
          !existsSync(join(blobsDir, `${row.body_sha256}.txt`))
        ) issues.push(`manual-reviews.jsonl line ${index + 1}: body blob is missing`);
        previousReviewHash = claimed;
      } catch (error) {
        issues.push(
          `manual-reviews.jsonl line ${index + 1}: invalid JSON (${serializeError(error).message})`,
        );
      }
    }
  }
  for (const rel of index.keys()) {
    if (!existsSync(join(directory, rel))) issues.push(`${rel}: indexed trace is missing`);
  }
  const counts = manifest?.counts as Record<string, unknown> | undefined;
  if (counts) {
    if (counts.started !== traces) issues.push("manifest started count does not match trace files");
    if (counts.succeeded !== indexedStatuses.success)
      issues.push("manifest succeeded count does not match cells.jsonl");
    if (counts.failed !== indexedStatuses.failed)
      issues.push("manifest failed count does not match cells.jsonl");
    if (counts.interrupted !== indexedStatuses.interrupted)
      issues.push("manifest interrupted count does not match cells.jsonl");
    if (
      manifest?.status === "completed" &&
      typeof counts.expected === "number" &&
      counts.expected !== traces
    )
      issues.push("completed run does not contain the expected number of traces");
  }
  const archive = manifest?.archive as Record<string, unknown> | undefined;
  if (archive && archive.cells_index_final_sha256 !== previousSummaryHash)
    issues.push("manifest cells index final hash does not match cells.jsonl");
  return { ok: issues.length === 0, traces, completeTraces, issues };
}
