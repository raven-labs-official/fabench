/** Build the Beta Raven answer table and Brier analysis from registry records. */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadBetaRaven } from "../datasets/beta-raven-bench.js";
import { publishBrierReport } from "./brier/publication.js";
import type { Policy } from "./brier/records.js";
import { readRegistryData } from "./brier/registry.js";
import { buildBrierReport } from "./brier/report.js";
import { SHARED_BENCH_DIR, SHARED_REGISTRY_PATH } from "../path-config.js";
import { projectEnv } from "../env-names.js";

const argv = process.argv.slice(2).filter((arg) => arg !== "--");
function option(name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
}

const registryPath = resolve(
  option(
    "registry",
    projectEnv("FABENCH_EXPERIMENT_REGISTRY") ?? SHARED_REGISTRY_PATH,
  ),
);
const outputRoot = resolve(
  option(
    "output-root",
    projectEnv("FABENCH_BRIER_ANALYSIS_ROOT") ??
      join(SHARED_BENCH_DIR, "analysis", "brier-index"),
  ),
);
const policyPath = resolve(
  option("policy", join(process.cwd(), "config", "brier-analysis-policy.json")),
);
const bootstrapIters = Number(option("iters", "20000"));
if (!Number.isInteger(bootstrapIters) || bootstrapIters < 100) {
  throw new Error("--iters must be an integer >= 100");
}
if (!existsSync(registryPath))
  throw new Error(`registry not found: ${registryPath}`);
if (!existsSync(policyPath))
  throw new Error(`analysis policy not found: ${policyPath}`);

const policy = JSON.parse(readFileSync(policyPath, "utf8")) as Policy;
const questions = loadBetaRaven("selected_300");
const registry = readRegistryData(registryPath);
publishBrierReport(
  outputRoot,
  buildBrierReport({
    registry,
    questions,
    policy,
    registryPath,
    bootstrapIters,
  }),
);
