/**
 * Package-root-relative paths for the two directories every script touches.
 *
 * Scripts used to compute these themselves as `join(import.meta.dirname, "../data")`,
 * which encodes how deep the script sits. Moving a script one directory down silently
 * repointed it at `src/data` — no type error, just an ENOENT at runtime, and for a
 * writer, output quietly landing in the wrong place. Resolving from this file instead
 * makes the depth a property of one module rather than of twenty.
 */
import { join, resolve } from "node:path";
import { projectEnv } from "./env-names.js";

/** The `bench/` package root. This file lives at `src/`, so one level up. */
export const PKG_ROOT = join(import.meta.dirname, "..");

/** Default output location for anything a corpus script writes. Not in the repository. */
export const DATA_DIR = join(PKG_ROOT, "data");

/**
 * Experiment output — JSON results and run logs.
 *
 * A read-only shared release cannot write beside its source. The shared launcher therefore
 * points this at a unique directory under the shared runs directory; local development keeps
 * the historical package-relative default.
 */
export const RESULTS_DIR = resolve(
  projectEnv("FABENCH_RESULTS_DIR")?.trim() || join(PKG_ROOT, "results"),
);

/**
 * Where the frozen index lives. 143 GiB, so it is never in the repository and never has a
 * default: the path differs on every machine it will run on, and a hard-coded one silently
 * points a cloud run at a laptop's mount point that does not exist there.
 *
 * Read through `corpusDb()` so a missing value fails with an instruction rather than an
 * ENOENT from somewhere deep in SQLite.
 */
export function corpusDb(): string {
  const p = projectEnv("FABENCH_CORPUS_DB")?.trim();
  if (!p) {
    throw new Error(
      "FABENCH_CORPUS_DB is not set — it must point at the frozen corpus SQLite file.\n" +
        "  export FABENCH_CORPUS_DB=/path/to/ccnews-2026.db",
    );
  }
  return p;
}
