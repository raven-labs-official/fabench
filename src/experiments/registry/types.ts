/** Public registry types and the raw `runs` row shape shared by the registry modules. */

export type RegistryRunStatus =
  | "claimed"
  | "running"
  | "sleeping"
  | "completed"
  | "failed"
  | "interrupted"
  | "blocked";

export interface RegistryCellSpec {
  conditionId: string;
  questionId: string;
  arm: string;
}

export interface RegistryRunInput {
  runId?: string;
  experimentKey: string;
  tag: string;
  expectedCells: number;
  config: Record<string, unknown>;
  cells: RegistryCellSpec[];
  replicate?: boolean;
  replicateReason?: string;
  leaseSeconds?: number;
}

export interface ReusedRegistryCell extends RegistryCellSpec {
  probability: number;
  sourceRunId: string;
  tracePath: string | null;
}

export interface BlockedRegistryCell extends RegistryCellSpec {
  owner: string;
  runId: string;
  tag: string;
  leaseExpiresUtc: string;
}

export interface RegistryPreflight {
  runId: string;
  claimed: RegistryCellSpec[];
  reused: ReusedRegistryCell[];
  blocked: BlockedRegistryCell[];
}

export interface RegistryCellResult {
  conditionId: string;
  questionId: string;
  arm: string;
  status: "success" | "failed" | "interrupted";
  probability?: number | null;
  tracePath?: string | null;
  summary?: Record<string, unknown>;
}

export interface RegistryRunRow {
  runId: string;
  tag: string;
  owner: string;
  host: string;
  pid: number;
  status: RegistryRunStatus | "stale";
  storedStatus: RegistryRunStatus;
  expectedCells: number;
  claimedCells: number;
  reusedCells: number;
  succeededCells: number;
  failedCells: number;
  interruptedCells: number;
  startedAtUtc: string;
  lastHeartbeatUtc: string;
  finishedAtUtc: string | null;
  traceDirectory: string | null;
  config: Record<string, unknown> | null;
  configError?: string;
}

/** A targeted operation requires valid configuration; listings also retain damaged rows. */
export interface ConfiguredRegistryRun extends RegistryRunRow {
  config: Record<string, unknown>;
}

export interface PromoteLegacyClosedBookInput {
  directory: string;
  conditionId: string;
  expectedModel: string;
  reason: string;
}

export interface PromoteLegacyClosedBookResult {
  sourceRunId: string;
  eligible: number;
  inserted: number;
  alreadyPresent: number;
  rejected: number;
}

export interface PromoteEquivalentConditionInput {
  sourceConditionId: string;
  targetCondition: Record<string, unknown>;
  reason: string;
}

export interface PromoteEquivalentConditionResult {
  sourceConditionId: string;
  targetConditionId: string;
  eligible: number;
  inserted: number;
  alreadyPresent: number;
}

/** Raw `runs` table row. Internal to src/experiments/registry/; not re-exported. */
export interface DbRunRow {
  run_id: string;
  tag: string;
  owner: string;
  host: string;
  pid: number;
  process_started_ticks: string | null;
  boot_id: string | null;
  status: RegistryRunStatus;
  expected_cells: number;
  claimed_cells: number;
  reused_cells: number;
  succeeded_cells: number;
  failed_cells: number;
  interrupted_cells: number;
  started_at_utc: string;
  last_heartbeat_utc: string;
  finished_at_utc: string | null;
  trace_directory: string | null;
  config_json: string;
}
