/**
 * Optional non-secret paths and installation settings; environment overrides remain compatible.
 *
 * A value comes from the first of: its environment variable (FABENCH_*, or the former RAVEN_*
 * name when that is unset; see env-names.ts); the JSON file named by FABENCH_PATHS_CONFIG;
 * config/site.json, where a deployment may commit its own defaults (the public source tree has
 * none). Relative paths in a file resolve against that file's directory. tools/path_config.py reads the same files with the same rules, and
 * docs/configuration.md lists every key.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { projectEnv } from "./env-names.js";

/** A deployment's committed defaults. This file sits in src/, one level below the root. */
export const SITE_CONFIG_FILE = join(import.meta.dirname, "..", "config", "site.json");

/**
 * Roots used when none is configured. Nothing can exist or be created under /dev/null, so
 * existence checks fail and writes fail, exactly as on a host without the shared filesystem,
 * and an error that names a path below one of them also names the variable to set.
 */
export const UNCONFIGURED_SHARED_ROOT = "/dev/null/FABENCH_SHARED_ROOT-not-set";
export const UNCONFIGURED_DATA_ROOT = "/dev/null/FABENCH_DATA_ROOT-not-set";

function readConfig(path: string): Record<string, unknown> {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read path configuration ${path}`, { cause: error });
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${path}: path configuration must be a JSON object`);
  }
  return config as Record<string, unknown>;
}

/** The first configuration file that sets `key`, and the value it gives. */
function configEntry(key: string, env: NodeJS.ProcessEnv, siteFile: string):
  { file: string; value: unknown } | undefined {
  for (const file of [projectEnv("FABENCH_PATHS_CONFIG", env)?.trim(), existsSync(siteFile) ? siteFile : undefined]) {
    if (!file) continue;
    const path = resolve(file);
    const value = readConfig(path)[key];
    if (value !== undefined) return { file: path, value };
  }
  return undefined;
}

export function configuredPath(
  key: string,
  environmentName: string,
  env: NodeJS.ProcessEnv = process.env,
  siteFile: string = SITE_CONFIG_FILE,
): string | undefined {
  const override = projectEnv(environmentName, env)?.trim();
  if (override) return resolve(override);
  const entry = configEntry(key, env, siteFile);
  if (!entry) return undefined;
  if (typeof entry.value !== "string" || !entry.value.trim()) {
    throw new Error(`${entry.file}: ${key} must be a nonempty path`);
  }
  return resolve(dirname(entry.file), entry.value);
}

/** A non-path setting (a name), with the same layers as configuredPath. */
export function configuredSetting(
  key: string,
  environmentName: string,
  env: NodeJS.ProcessEnv = process.env,
  siteFile: string = SITE_CONFIG_FILE,
): string | undefined {
  const override = projectEnv(environmentName, env)?.trim();
  if (override) return override;
  const entry = configEntry(key, env, siteFile);
  if (!entry) return undefined;
  if (typeof entry.value !== "string" || !entry.value.trim()) {
    throw new Error(`${entry.file}: ${key} must be a nonempty string`);
  }
  return entry.value;
}

/*
 * Fixed locations of the multi-user shared filesystem layout, all below one configured root.
 * tools/path_config.py defines the same names and values. Callers keep their own environment
 * overrides; checks that require a shared location compare against these values.
 */
export const SHARED_ROOT = configuredPath("sharedRoot", "FABENCH_SHARED_ROOT") ?? UNCONFIGURED_SHARED_ROOT;
export const SHARED_RUNS_ROOT = `${SHARED_ROOT}/runs`;
export const SHARED_BENCH_DIR = `${SHARED_RUNS_ROOT}/raven-bench`;
export const SHARED_RESULTS_DIR = `${SHARED_BENCH_DIR}/results`;
export const SHARED_REGISTRY_PATH = `${SHARED_BENCH_DIR}/registry.sqlite`;
export const TEAM_CONFIG_DIR = `${SHARED_ROOT}/config/raven-bench`;
export const CURRENT_RELEASE = `${SHARED_ROOT}/current/raven-bench`;
export const FROZEN_SHARED_CACHE = `${SHARED_ROOT}/cache/frozen-query/cache.sqlite`;

/** Name of the shared server in messages; the host name when none is configured. */
export const SITE_NAME = configuredSetting("siteName", "FABENCH_SITE_NAME") ?? hostname();

/**
 * Root of the data that run presets name as ${FABENCH_DATA_ROOT} (indexes, question sets,
 * caches). Read when a preset or override file uses the placeholder.
 */
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return configuredPath("dataRoot", "FABENCH_DATA_ROOT", env) ?? UNCONFIGURED_DATA_ROOT;
}
