/**
 * Shared, multi-user experiment registry for FABench.
 *
 * This file is the public entry point. The implementation lives in ./registry/:
 * schema.ts (location, connection, tables), liveness.ts (clock, owner, stale runs),
 * claims.ts (preflight, claims, heartbeats), run-writes.ts (cell results, run completion),
 * queries.ts (lookups and listings), trace-import.ts (historical archives),
 * promotion.ts (audited condition promotion) and code-identity.ts.
 */
import type { DatabaseSync } from "node:sqlite";
import * as claims from "./registry/claims.js";
import { DEFAULT_LEASE_SECONDS } from "./registry/liveness.js";
import * as promotion from "./registry/promotion.js";
import * as queries from "./registry/queries.js";
import * as runWrites from "./registry/run-writes.js";
import { defaultRegistryPath, openRegistryDatabase } from "./registry/schema.js";
import { importTraceArchive } from "./registry/trace-import.js";
import type {
  ConfiguredRegistryRun,
  PromoteEquivalentConditionInput,
  PromoteEquivalentConditionResult,
  PromoteLegacyClosedBookInput,
  PromoteLegacyClosedBookResult,
  RegistryCellResult,
  RegistryPreflight,
  RegistryRunInput,
  RegistryRunRow,
  RegistryRunStatus,
  ReusedRegistryCell,
} from "./registry/types.js";

export { experimentCodeIdentity } from "./registry/code-identity.js";
export { DEFAULT_LEASE_SECONDS } from "./registry/liveness.js";
export { defaultRegistryPath, REGISTRY_SCHEMA_VERSION } from "./registry/schema.js";
export type {
  BlockedRegistryCell,
  ConfiguredRegistryRun,
  PromoteEquivalentConditionInput,
  PromoteEquivalentConditionResult,
  PromoteLegacyClosedBookInput,
  PromoteLegacyClosedBookResult,
  RegistryCellResult,
  RegistryCellSpec,
  RegistryPreflight,
  RegistryRunInput,
  RegistryRunRow,
  RegistryRunStatus,
  ReusedRegistryCell,
} from "./registry/types.js";

export class ExperimentRegistry {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path = defaultRegistryPath()) {
    this.path = path;
    this.db = openRegistryDatabase(path);
  }

  close(): void {
    this.db.close();
  }

  prepareRun(input: RegistryRunInput): RegistryPreflight {
    return claims.prepareRun(this.db, input);
  }

  markRunning(runId: string, traceDirectory: string | null): void {
    claims.markRunning(this.db, runId, traceDirectory);
  }

  markCellRunning(runId: string, conditionId: string, questionId: string): void {
    claims.markCellRunning(this.db, runId, conditionId, questionId);
  }

  heartbeat(runId: string, leaseSeconds = DEFAULT_LEASE_SECONDS): void {
    claims.heartbeat(this.db, runId, leaseSeconds);
  }

  recordCell(runId: string, result: RegistryCellResult): void {
    runWrites.recordCell(this.db, runId, result);
  }

  /** Retract cells from an arm whose shared treatment failed after the run had started. */
  invalidateRunArm(runId: string, arm: string): number {
    return runWrites.invalidateRunArm(this.db, runId, arm);
  }

  finishRun(
    runId: string,
    status: Exclude<RegistryRunStatus, "claimed" | "running" | "sleeping">,
    error?: string,
  ): void {
    runWrites.finishRun(this.db, runId, status, error);
  }

  getReusable(conditionId: string, questionId: string): ReusedRegistryCell | null {
    return queries.getReusable(this.db, conditionId, questionId);
  }

  /** Historical reuse receipts for this run, independent of later canonical replacements. */
  getRunReusedCells(runId: string): ReusedRegistryCell[] {
    return queries.getRunReusedCells(this.db, runId);
  }

  getRun(runId: string): ConfiguredRegistryRun | null {
    return queries.getRun(this.db, runId);
  }

  listRuns(options: { mine?: boolean; active?: boolean } = {}): RegistryRunRow[] {
    return queries.listRuns(this.db, options);
  }

  importTraceArchive(directory: string): { runId: string; cells: number; reusable: number } {
    return importTraceArchive(this.db, directory);
  }

  /** Explicitly map audited legacy closed-book results onto a modern condition id. */
  promoteLegacyClosedBook(
    input: PromoteLegacyClosedBookInput,
  ): PromoteLegacyClosedBookResult {
    return promotion.promoteLegacyClosedBook(this.db, input);
  }

  /** Map trace-verified successes across a code-only condition fingerprint change. */
  promoteEquivalentCondition(
    input: PromoteEquivalentConditionInput,
  ): PromoteEquivalentConditionResult {
    return promotion.promoteEquivalentCondition(this.db, input);
  }
}
