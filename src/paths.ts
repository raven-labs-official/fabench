/** Benchmark-owned output paths; retrieval owns corpus configuration. */
import { join } from "node:path";
import { configuredPath } from "./path-config.js";
export { corpusDb } from "../vendor/retrieval-infra/src/paths.js";

export const PKG_ROOT = join(import.meta.dirname, "..");
export const DATA_DIR = join(PKG_ROOT, "data");
export const RESULTS_DIR =
  configuredPath("resultsDir", "FABENCH_RESULTS_DIR") ?? join(PKG_ROOT, "results");
