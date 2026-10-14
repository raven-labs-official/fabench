/** Clock helpers, run owner and stale-run detection shared by the registry modules. */
import { userInfo } from "node:os";
import { matchesRunningProcess } from "../../process-identity.js";
import type { DbRunRow, RegistryRunRow } from "./types.js";

export const DEFAULT_LEASE_SECONDS = 120;

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

export function currentOwner(): string {
  return process.env.USER?.trim() || userInfo().username || `uid-${process.getuid?.() ?? "?"}`;
}

export function runMetadata(row: DbRunRow, now = Date.now()): Omit<RegistryRunRow, "config" | "configError"> {
  const heartbeatStale = now - Date.parse(row.last_heartbeat_utc) > DEFAULT_LEASE_SECONDS * 1000;
  const potentiallyActive = ["claimed", "running", "sleeping"].includes(row.status);
  const stale = potentiallyActive && heartbeatStale && !matchesRunningProcess({
    pid: row.pid,
    host: row.host,
    startedTicks: row.process_started_ticks,
    bootId: row.boot_id,
  });
  return {
    runId: row.run_id,
    tag: row.tag,
    owner: row.owner,
    host: row.host,
    pid: row.pid,
    status: stale ? "stale" : row.status,
    storedStatus: row.status,
    expectedCells: row.expected_cells,
    claimedCells: row.claimed_cells,
    reusedCells: row.reused_cells,
    succeededCells: row.succeeded_cells,
    failedCells: row.failed_cells,
    interruptedCells: row.interrupted_cells,
    startedAtUtc: row.started_at_utc,
    lastHeartbeatUtc: row.last_heartbeat_utc,
    finishedAtUtc: row.finished_at_utc,
    traceDirectory: row.trace_directory,
  };
}
