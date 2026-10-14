/** Registry location, connection settings and table definitions. */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RESULTS_DIR } from "../../paths.js";
import { configuredPath, SHARED_REGISTRY_PATH, SHARED_RUNS_ROOT } from "../../path-config.js";

export const REGISTRY_SCHEMA_VERSION = 1;

export function defaultRegistryPath(): string {
  const configured = configuredPath("registryPath", "FABENCH_EXPERIMENT_REGISTRY");
  if (configured) return resolve(configured);
  if (existsSync(SHARED_RUNS_ROOT)) return SHARED_REGISTRY_PATH;
  return join(RESULTS_DIR, "experiment-registry.sqlite");
}

/** Open the registry, creating its directory and tables when they do not exist yet. */
export function openRegistryDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o2775 });
  }
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=10000;`);
  if (path !== ":memory:") db.exec(`PRAGMA journal_mode=WAL;`);
  db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        experiment_key TEXT NOT NULL,
        tag TEXT NOT NULL,
        owner TEXT NOT NULL,
        host TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_started_ticks TEXT,
        boot_id TEXT,
        status TEXT NOT NULL,
        expected_cells INTEGER NOT NULL,
        claimed_cells INTEGER NOT NULL DEFAULT 0,
        reused_cells INTEGER NOT NULL DEFAULT 0,
        succeeded_cells INTEGER NOT NULL DEFAULT 0,
        failed_cells INTEGER NOT NULL DEFAULT 0,
        interrupted_cells INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL,
        trace_directory TEXT,
        log_path TEXT,
        replicate_reason TEXT,
        started_at_utc TEXT NOT NULL,
        last_heartbeat_utc TEXT NOT NULL,
        finished_at_utc TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, last_heartbeat_utc);
      CREATE INDEX IF NOT EXISTS idx_runs_experiment ON runs(experiment_key, started_at_utc);

      CREATE TABLE IF NOT EXISTS canonical_cells (
        condition_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        arm TEXT NOT NULL,
        probability REAL NOT NULL,
        source_run_id TEXT NOT NULL,
        trace_path TEXT,
        summary_json TEXT NOT NULL,
        completed_at_utc TEXT NOT NULL,
        PRIMARY KEY(condition_id, question_id)
      );

      CREATE TABLE IF NOT EXISTS run_cells (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        condition_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        arm TEXT NOT NULL,
        status TEXT NOT NULL,
        probability REAL,
        source_run_id TEXT,
        trace_path TEXT,
        updated_at_utc TEXT NOT NULL,
        PRIMARY KEY(run_id, condition_id, question_id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_cells_status ON run_cells(run_id, status);

      CREATE TABLE IF NOT EXISTS cell_claims (
        condition_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        arm TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        lease_expires_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        PRIMARY KEY(condition_id, question_id)
      );
      PRAGMA user_version=${REGISTRY_SCHEMA_VERSION};
    `);
  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o664);
    } catch {
      // The surrounding directory ACL is the authority on managed/shared mounts.
    }
  }
  return db;
}
