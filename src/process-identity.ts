import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export interface ProcessIdentity {
  pid: number;
  state: string;
  startedTicks: string;
  bootId: string;
}

/** Linux start time and boot ID distinguish a process from a later reuse of its PID. */
export function readProcessIdentity(pid = process.pid): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const state = fields[0];
    const startedTicks = fields[19];
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!state || !startedTicks || !bootId) return null;
    return { pid, state, startedTicks, bootId };
  } catch {
    return null; // A disappeared or unreadable process cannot establish liveness.
  }
}

export function matchesRunningProcess(saved: {
  pid: number;
  host: string;
  startedTicks?: string | null;
  bootId?: string | null;
}): boolean {
  if (saved.host !== hostname()) return false;
  const live = readProcessIdentity(saved.pid);
  return live !== null
    && live.state !== "Z" && live.state !== "X"
    && (!saved.startedTicks || saved.startedTicks === live.startedTicks)
    && (!saved.bootId || saved.bootId === live.bootId);
}
