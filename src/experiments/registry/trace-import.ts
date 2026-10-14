/** Import a historical trace archive (manifest.json + cells.jsonl) into the registry. */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sha256Json } from "../../tracing/trace-archive.js";
import { nowIso } from "./liveness.js";
import { refreshCounts } from "./run-writes.js";
import type { RegistryRunStatus } from "./types.js";

export function importTraceArchive(db: DatabaseSync, directory: string): { runId: string; cells: number; reusable: number } {
  const manifest = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  const runId = String(manifest.run_id);
  const runConfig = (manifest.run ?? {}) as Record<string, unknown>;
  const runtime = (manifest.runtime ?? {}) as Record<string, unknown>;
  const counts = (manifest.counts ?? {}) as Record<string, unknown>;
  const statusRaw = String(manifest.status ?? "failed");
  const status = (["running", "completed", "failed", "interrupted"] as const)
    .includes(statusRaw as "running")
    ? statusRaw as RegistryRunStatus
    : "failed";
  const started = String(manifest.started_at_utc ?? nowIso());
  const updated = String(manifest.updated_at_utc ?? started);
  const lines = existsSync(join(directory, "cells.jsonl"))
    ? readFileSync(join(directory, "cells.jsonl"), "utf8").split("\n").filter(Boolean)
    : [];

  db.exec("BEGIN IMMEDIATE");
  let reusable = 0;
  try {
    db.prepare(`
        INSERT INTO runs (
          run_id, experiment_key, tag, owner, host, pid, process_started_ticks, boot_id,
          status, expected_cells, config_json, trace_directory,
          started_at_utc, last_heartbeat_utc, finished_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status=excluded.status, expected_cells=excluded.expected_cells,
          trace_directory=excluded.trace_directory,
          last_heartbeat_utc=excluded.last_heartbeat_utc,
          finished_at_utc=excluded.finished_at_utc
      `).run(
      runId,
      sha256Json({ imported_run_id: runId }),
      String(manifest.tag ?? "imported"),
      String(runtime.user ?? "unknown"),
      String(runtime.host ?? "unknown"),
      Number(runtime.pid ?? 0),
      null,
      null,
      status,
      Number(counts.expected ?? lines.length),
      JSON.stringify(runConfig),
      resolve(directory),
      started,
      updated,
      manifest.finished_at_utc == null ? null : String(manifest.finished_at_utc),
    );
    db.prepare(`DELETE FROM run_cells WHERE run_id=?`).run(runId);
    const insertRunCell = db.prepare(`
        INSERT INTO run_cells (
          run_id, condition_id, question_id, arm, status, probability,
          source_run_id, trace_path, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    const insertCanonical = db.prepare(`
        INSERT OR IGNORE INTO canonical_cells (
          condition_id, question_id, arm, probability, source_run_id,
          trace_path, summary_json, completed_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      const condition = row.condition as Record<string, unknown> | undefined;
      const explicitConditionId =
        typeof condition?.condition_id === "string" ? condition.condition_id : null;
      const conditionId = explicitConditionId ??
        `legacy:${sha256Json({
          predictor_id: row.predictor_id ?? null,
          arm: row.arm ?? null,
          run_id: runId,
        }).slice(0, 24)}`;
      const questionId = String(row.question_id);
      const arm = String(row.arm);
      const cellStatus = String(row.status);
      const probability = typeof row.probability === "number" ? row.probability : null;
      insertRunCell.run(
        runId,
        conditionId,
        questionId,
        arm,
        cellStatus,
        probability,
        null,
        row.trace_file == null ? null : join(directory, String(row.trace_file)),
        updated,
      );
      // Legacy rows are visible for history but unsafe to reuse: their condition omitted
      // source fingerprint and several knobs. Explicit new-schema conditions are reusable.
      if (explicitConditionId && cellStatus === "success" && probability != null) {
        const result = insertCanonical.run(
          conditionId,
          questionId,
          arm,
          probability,
          runId,
          row.trace_file == null ? null : join(directory, String(row.trace_file)),
          JSON.stringify({ imported: true }),
          updated,
        );
        reusable += Number(result.changes > 0);
      }
    }
    refreshCounts(db, runId);
    db.exec("COMMIT");
    return { runId, cells: lines.length, reusable };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
