/** Read-only lookups: reusable cells, reuse receipts and run listings. */
import type { DatabaseSync } from "node:sqlite";
import { parseRegistryObject } from "../registry-json.js";
import { currentOwner, runMetadata } from "./liveness.js";
import type {
  ConfiguredRegistryRun,
  DbRunRow,
  RegistryRunRow,
  ReusedRegistryCell,
} from "./types.js";

export function getReusable(db: DatabaseSync, conditionId: string, questionId: string): ReusedRegistryCell | null {
  const row = db.prepare(`
      SELECT arm, probability, source_run_id, trace_path
      FROM canonical_cells WHERE condition_id=? AND question_id=?
    `).get(conditionId, questionId) as
    | { arm: string; probability: number; source_run_id: string; trace_path: string | null }
    | undefined;
  return row
    ? {
        conditionId,
        questionId,
        arm: row.arm,
        probability: row.probability,
        sourceRunId: row.source_run_id,
        tracePath: row.trace_path,
      }
    : null;
}

/** Historical reuse receipts for this run, independent of later canonical replacements. */
export function getRunReusedCells(db: DatabaseSync, runId: string): ReusedRegistryCell[] {
  const rows = db.prepare(`
      SELECT condition_id, question_id, arm, probability, source_run_id, trace_path
      FROM run_cells WHERE run_id=? AND status='reused'
    `).all(runId) as unknown as Array<{
    condition_id: string; question_id: string; arm: string; probability: number;
    source_run_id: string; trace_path: string | null;
  }>;
  return rows.map(row => ({conditionId: row.condition_id, questionId: row.question_id,
    arm: row.arm, probability: row.probability, sourceRunId: row.source_run_id, tracePath: row.trace_path}));
}

export function getRun(db: DatabaseSync, runId: string): ConfiguredRegistryRun | null {
  const row = db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId) as DbRunRow | undefined;
  if (!row) return null;
  return {
    ...runMetadata(row),
    config: parseRegistryObject<Record<string, unknown>>(row.config_json, `${row.run_id} config_json`),
  };
}

export function listRuns(db: DatabaseSync, options: { mine?: boolean; active?: boolean } = {}): RegistryRunRow[] {
  const rows = db.prepare(`SELECT * FROM runs ORDER BY started_at_utc DESC`).all() as
    unknown as DbRunRow[];
  const now = Date.now();
  return rows
    .filter((row) => !options.mine || row.owner === currentOwner())
    .filter((row) => !options.active || ["claimed", "running", "sleeping"].includes(row.status))
    .map((row) => {
      const metadata = runMetadata(row, now);
      try {
        const config = parseRegistryObject<Record<string, unknown>>(row.config_json, `${row.run_id} config_json`);
        return { ...metadata, config };
      } catch (error) {
        return { ...metadata, config: null, configError: (error as Error).message };
      }
    });
}
