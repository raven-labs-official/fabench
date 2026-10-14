import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isJsonObject, parseRegistryObject } from "../experiments/registry-json.js";

export interface RunResources {
  status: "available" | "not_recorded" | "unavailable" | "invalid";
  rows: Record<string, unknown>[];
}

/** Resolve this run's summary first; legacy results roots may contain many other runs. */
export function readRunResources(
  run: { runId: string; tag: string; traceDirectory: string | null },
  readAllowedFile: (path: string) => string | null,
): RunResources {
  if (!run.traceDirectory) return { status: "not_recorded", rows: [] };
  const parent = dirname(dirname(run.traceDirectory));
  let names: string[];
  try {
    names = readdirSync(parent)
      .filter(name => name.startsWith("forecast-value-") && name.endsWith(".json"))
      .sort();
  } catch (error) {
    const status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_recorded" : "unavailable";
    return { status, rows: [] };
  }
  const expected = `forecast-value-${run.tag}.json`;
  if (basename(expected) === expected && names.includes(expected)) {
    names = [expected, ...names.filter(name => name !== expected)];
  }

  let unreadable = false;
  for (const name of names) {
    const raw = readAllowedFile(join(parent, name));
    if (raw === null) {
      unreadable = true;
      continue;
    }
    let result: Record<string, unknown>;
    try {
      result = parseRegistryObject(raw, "forecast summary");
    } catch {
      if (name === expected) return { status: "invalid", rows: [] };
      unreadable = true; // Its run ID cannot be established.
      continue;
    }
    if (result.trace_run_id !== run.runId) continue;
    if (!Object.hasOwn(result, "resources")) return { status: "not_recorded", rows: [] };
    if (!Array.isArray(result.resources) || !result.resources.every(isJsonObject)) {
      return { status: "invalid", rows: [] };
    }
    return { status: "available", rows: result.resources };
  }
  return { status: unreadable ? "unavailable" : "not_recorded", rows: [] };
}
