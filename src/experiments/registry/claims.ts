/** Run preflight (reuse or claim each cell), run start and lease heartbeats. */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { readProcessIdentity } from "../../process-identity.js";
import { addSeconds, currentOwner, DEFAULT_LEASE_SECONDS, nowIso } from "./liveness.js";
import type {
  BlockedRegistryCell,
  RegistryCellSpec,
  RegistryPreflight,
  RegistryRunInput,
  ReusedRegistryCell,
} from "./types.js";

export function prepareRun(db: DatabaseSync, input: RegistryRunInput): RegistryPreflight {
  if (input.replicate && !input.replicateReason?.trim()) {
    throw new Error(`replicate runs require a non-empty replicateReason`);
  }
  const runId = input.runId ?? randomUUID();
  const started = nowIso();
  const identity = readProcessIdentity();
  const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const claimed: RegistryCellSpec[] = [];
  const reused: ReusedRegistryCell[] = [];
  const blocked: BlockedRegistryCell[] = [];

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`DELETE FROM cell_claims WHERE lease_expires_utc <= ?`).run(started);
    const canonical = db.prepare(`
        SELECT probability, source_run_id, trace_path
        FROM canonical_cells WHERE condition_id=? AND question_id=?
      `);
    const activeClaim = db.prepare(`
        SELECT c.run_id, c.lease_expires_utc, r.owner, r.tag
        FROM cell_claims c JOIN runs r ON r.run_id=c.run_id
        WHERE c.condition_id=? AND c.question_id=? AND c.lease_expires_utc>?
      `);

    for (const cell of input.cells) {
      const done = canonical.get(cell.conditionId, cell.questionId) as
        | { probability: number; source_run_id: string; trace_path: string | null }
        | undefined;
      if (done && !input.replicate) {
        reused.push({
          ...cell,
          probability: done.probability,
          sourceRunId: done.source_run_id,
          tracePath: done.trace_path,
        });
        continue;
      }
      const lock = activeClaim.get(cell.conditionId, cell.questionId, started) as
        | { run_id: string; lease_expires_utc: string; owner: string; tag: string }
        | undefined;
      if (lock) {
        blocked.push({
          ...cell,
          owner: lock.owner,
          runId: lock.run_id,
          tag: lock.tag,
          leaseExpiresUtc: lock.lease_expires_utc,
        });
      } else {
        claimed.push(cell);
      }
    }

    if (blocked.length) {
      db.exec("ROLLBACK");
      return { runId, claimed: [], reused, blocked };
    }

    db.prepare(`
        INSERT INTO runs (
          run_id, experiment_key, tag, owner, host, pid, process_started_ticks, boot_id,
          status, expected_cells, claimed_cells, reused_cells, config_json,
          replicate_reason, started_at_utc, last_heartbeat_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, ?, ?)
      `).run(
      runId,
      input.experimentKey,
      input.tag,
      currentOwner(),
      hostname(),
      process.pid,
      identity?.startedTicks ?? null,
      identity?.bootId ?? null,
      input.expectedCells,
      claimed.length,
      reused.length,
      JSON.stringify(input.config),
      input.replicateReason ?? null,
      started,
      started,
    );

    const insertRunCell = db.prepare(`
        INSERT INTO run_cells (
          run_id, condition_id, question_id, arm, status, probability,
          source_run_id, trace_path, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    for (const cell of reused)
      insertRunCell.run(
        runId,
        cell.conditionId,
        cell.questionId,
        cell.arm,
        "reused",
        cell.probability,
        cell.sourceRunId,
        cell.tracePath,
        started,
      );
    const claim = db.prepare(`
        INSERT OR REPLACE INTO cell_claims (
          condition_id, question_id, arm, run_id, lease_expires_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
    for (const cell of claimed) {
      insertRunCell.run(
        runId,
        cell.conditionId,
        cell.questionId,
        cell.arm,
        "claimed",
        null,
        null,
        null,
        started,
      );
      claim.run(
        cell.conditionId,
        cell.questionId,
        cell.arm,
        runId,
        addSeconds(started, leaseSeconds),
        started,
      );
    }
    db.exec("COMMIT");
    return { runId, claimed, reused, blocked: [] };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }
}

export function markRunning(db: DatabaseSync, runId: string, traceDirectory: string | null): void {
  const now = nowIso();
  db.prepare(`
      UPDATE runs SET status='running', trace_directory=?, last_heartbeat_utc=?
      WHERE run_id=?
    `).run(traceDirectory, now, runId);
}

export function markCellRunning(db: DatabaseSync, runId: string, conditionId: string, questionId: string): void {
  db.prepare(`
      UPDATE run_cells SET status='running', updated_at_utc=?
      WHERE run_id=? AND condition_id=? AND question_id=? AND status='claimed'
    `).run(nowIso(), runId, conditionId, questionId);
}

export function heartbeat(db: DatabaseSync, runId: string, leaseSeconds = DEFAULT_LEASE_SECONDS): void {
  const now = nowIso();
  const expires = addSeconds(now, leaseSeconds);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE runs SET last_heartbeat_utc=? WHERE run_id=?`).run(now, runId);
    db.prepare(`
        UPDATE cell_claims SET lease_expires_utc=?, updated_at_utc=? WHERE run_id=?
      `).run(expires, now, runId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
