/**
 * Installation settings that differ between machines: the root of a multi-user shared
 * filesystem, the User-Agent sent to historical sources and former names of renamed
 * environment variables. None of them is a secret.
 *
 * A value comes from the first of:
 *   1. its environment variable (where it has one; a former RAVEN_* name is read when the
 *      FABENCH_* name is unset, see env-names.ts);
 *   2. the JSON file named by FABENCH_PATHS_CONFIG (the file the benchmark also reads);
 *   3. configs/site.json in this package, where a deployment may commit its own defaults.
 * Relative paths in a file resolve against that file's directory. A file that is named or
 * present but unreadable is an error, so a typo never silently falls back to a default.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PKG_ROOT } from "./paths.js";
import { projectEnv } from "./env-names.js";

/** A deployment's committed defaults. The public source tree has none. */
export const SITE_CONFIG_FILE = join(PKG_ROOT, "configs", "site.json");

/**
 * The shared root when none is configured. Nothing can exist or be created under /dev/null, so
 * existence checks fail and writes fail, exactly as on a host without a shared filesystem, and
 * an error that names a path below it also names the variable to set.
 */
export const UNCONFIGURED_SHARED_ROOT = "/dev/null/FABENCH_SHARED_ROOT-not-set";

export interface SiteOptions {
  env?: NodeJS.ProcessEnv;
  siteFile?: string;
}

function readObject(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read path configuration ${path}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: path configuration must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** The first configuration file that sets `key`, with its raw value. */
function fileValue(key: string, options: SiteOptions): { file: string; value: unknown } | undefined {
  const env = options.env ?? process.env;
  const siteFile = options.siteFile ?? SITE_CONFIG_FILE;
  for (const file of [projectEnv("FABENCH_PATHS_CONFIG", env)?.trim(), existsSync(siteFile) ? siteFile : undefined]) {
    if (!file) continue;
    const path = resolve(file);
    const value = readObject(path)[key];
    if (value !== undefined) return { file: path, value };
  }
  return undefined;
}

/** The configured value, or undefined when no layer sets it. */
export function siteSetting(
  key: string,
  environmentName: string,
  options: SiteOptions & { path?: boolean } = {},
): string | undefined {
  const override = projectEnv(environmentName, options.env ?? process.env)?.trim();
  if (override) return options.path ? resolve(override) : override;
  const found = fileValue(key, options);
  if (!found) return undefined;
  if (typeof found.value !== "string" || !found.value.trim()) {
    throw new Error(`${found.file}: ${key} must be a nonempty ${options.path ? "path" : "string"}`);
  }
  return options.path ? resolve(dirname(found.file), found.value) : found.value;
}

/**
 * Former names of renamed environment variables (`envAliases`, e.g. {"NEW_NAME": ["OLD_NAME"]}).
 * Read from the configuration files only.
 */
export function formerVariableNames(name: string, options: SiteOptions = {}): string[] {
  const found = fileValue("envAliases", options);
  if (!found) return [];
  const aliases = found.value;
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    throw new Error(`${found.file}: envAliases must map a variable name to a list of former names`);
  }
  const former = (aliases as Record<string, unknown>)[name];
  if (former === undefined) return [];
  if (!Array.isArray(former) || former.some((alias) => typeof alias !== "string" || !/^[A-Z0-9_]+$/.test(alias))) {
    throw new Error(`${found.file}: envAliases.${name} must list environment variable names`);
  }
  return former as string[];
}

/** Root of the shared filesystem layout (team configuration, API admission database). */
export const SHARED_ROOT = siteSetting("sharedRoot", "FABENCH_SHARED_ROOT", { path: true }) ?? UNCONFIGURED_SHARED_ROOT;
/** Team configuration directory under the shared root. */
export const TEAM_CONFIG_DIR = `${SHARED_ROOT}/config/raven-bench`;
