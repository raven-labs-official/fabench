/** Cell results, arm invalidation, run completion and the per-run counters. */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./liveness.js";
import type { RegistryCellResult, RegistryRunStatus } from "./types.js";

export function recordCell(db: DatabaseSync, runId: string, result: RegistryCellResult): void {
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const claim = db.prepare(`
        SELECT run_id FROM cell_claims WHERE condition_id=? AND question_id=?
      `).get(result.conditionId, result.questionId) as { run_id: string } | undefined;
    if (claim?.run_id !== runId) {
      throw new Error(
        `cell claim is no longer owned by ${runId}: ` +
          `${result.conditionId}/${result.questionId}`,
      );
    }
    if (result.status === "success") {
      if (
        typeof result.probability !== "number" ||
        !Number.isFinite(result.probability) ||
        result.probability < 0 ||
        result.probability > 1
      ) {
        throw new Error(`successful registry cell needs a probability in [0,1]`);
      }
      db.prepare(`
          INSERT OR IGNORE INTO canonical_cells (
            condition_id, question_id, arm, probability, source_run_id,
            trace_path, summary_json, completed_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
        result.conditionId,
        result.questionId,
        result.arm,
        result.probability,
        runId,
        result.tracePath ?? null,
        JSON.stringify(result.summary ?? {}),
        now,
      );
    }
    db.prepare(`
        UPDATE run_cells
        SET status=?, probability=?, trace_path=?, updated_at_utc=?
        WHERE run_id=? AND condition_id=? AND question_id=?
      `).run(
      result.status,
      result.probability ?? null,
      result.tracePath ?? null,
      now,
      runId,
      result.conditionId,
      result.questionId,
    );
    db.prepare(`
        DELETE FROM cell_claims WHERE run_id=? AND condition_id=? AND question_id=?
      `).run(runId, result.conditionId, result.questionId);
    refreshCounts(db, runId);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }
}

/**
 * Retract cells from an arm whose shared treatment failed after the run had started.
 *
 * A model returning a probability is not enough when the condition promised Web evidence
 * and the Web pipeline was unavailable. Removing only canonical cells sourced by this run
 * preserves valid reused work from earlier runs while ensuring the invalid treatment cannot
 * be silently reused next time.
 */
export function invalidateRunArm(db: DatabaseSync, runId: string, arm: string): number {
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const deleted = db.prepare(`
        DELETE FROM canonical_cells WHERE source_run_id=? AND arm=?
      `).run(runId, arm);
    db.prepare(`
        UPDATE run_cells
        SET status='interrupted', probability=NULL, updated_at_utc=?
        WHERE run_id=? AND arm=? AND status IN ('claimed','running','success')
      `).run(now, runId, arm);
    db.prepare(`
        DELETE FROM cell_claims WHERE run_id=? AND arm=?
      `).run(runId, arm);
    refreshCounts(db, runId);
    db.exec("COMMIT");
    return Number(deleted.changes);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }
}

export function finishRun(
  db: DatabaseSync,
  runId: string,
  status: Exclude<RegistryRunStatus, "claimed" | "running" | "sleeping">,
  error?: string,
): void {
  const now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const unfinished = db.prepare(`
        SELECT COUNT(*) AS n FROM run_cells
        WHERE run_id=? AND status IN ('claimed','running')
      `).get(runId) as { n: number };
    if (status === "completed" && unfinished.n > 0)
      throw new Error(`cannot complete run ${runId}: ${unfinished.n} cells are unfinished`);
    db.prepare(`
        UPDATE run_cells SET status=?, updated_at_utc=?
        WHERE run_id=? AND status IN ('claimed','running')
      `).run("interrupted", now, runId);
    db.prepare(`DELETE FROM cell_claims WHERE run_id=?`).run(runId);
    refreshCounts(db, runId);
    db.prepare(`
        UPDATE runs SET status=?, error=?, finished_at_utc=?, last_heartbeat_utc=?
        WHERE run_id=?
      `).run(status, error ?? null, now, now, runId);
    db.exec("COMMIT");
  } catch (cause) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw cause;
  }
}

export function refreshCounts(db: DatabaseSync, runId: string): void {
  db.prepare(`
      UPDATE runs SET
        claimed_cells=(SELECT COUNT(*) FROM run_cells WHERE run_id=? AND status IN ('claimed','running')),
        reused_cells=(SELECT COUNT(*) FROM run_cells WHERE run_id=? AND status='reused'),
        succeeded_cells=(SELECT COUNT(*) FROM run_cells WHERE run_id=? AND status='success'),
        failed_cells=(SELECT COUNT(*) FROM run_cells WHERE run_id=? AND status='failed'),
        interrupted_cells=(SELECT COUNT(*) FROM run_cells WHERE run_id=? AND status='interrupted')
      WHERE run_id=?
    `).run(runId, runId, runId, runId, runId, runId);
}
