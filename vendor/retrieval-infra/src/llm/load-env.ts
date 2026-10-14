/**
 * Minimal .env reader for API keys (no dotenv dependency).
 *
 * Looks up process.env first, then the shared team env, then a repo-root .env fallback.
 * Only used to fetch provider API keys (KIMI_API_KEY / GLM_API_KEY / …) for the
 * LLM clients — never logs or returns secrets beyond the requested value.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PKG_ROOT } from "../paths.js";
import { formerVariableNames, TEAM_CONFIG_DIR } from "../site-config.js";
import { describeProjectEnv, formerEnvName, projectEnv } from "../env-names.js";

/** The repo root, one level above this package. */
// The central file is the server source of truth. Repo-local files remain last-resort
// compatibility for laptops and legacy worktrees, but new shared-server releases do not
// contain or need a .env file beside source code.
// Read when needed, so a test can point FABENCH_TEAM_ENV_FILE at its own file.
function envPaths(): string[] {
  return [
    projectEnv("FABENCH_TEAM_ENV_FILE")?.trim(),
    join(TEAM_CONFIG_DIR, "team.env"),
    join(process.cwd(), ".env"),
    join(PKG_ROOT, ".env"),
    join(PKG_ROOT, "..", ".env"),
  ].filter((path): path is string => Boolean(path));
}

let cache: { paths: string; values: Record<string, string> } | null = null;

function parseEnvFile(): Record<string, string> {
  const paths = envPaths();
  if (cache?.paths === paths.join("\n")) return cache.values;
  const out: Record<string, string> = {};
  const found = paths.find((p) => existsSync(p));
  if (found) {
    for (const line of readFileSync(found, "utf-8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1]!;
      let val = m[2]!.trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  }
  cache = { paths: paths.join("\n"), values: out };
  return out;
}

/**
 * Get an env value (process.env wins over the env file), or undefined. A FABENCH_* name that
 * is set nowhere falls back to its former RAVEN_* name, read the same way (see env-names.ts).
 */
export function getEnvKey(name: string): string | undefined {
  const value = process.env[name] ?? parseEnvFile()[name];
  if (value !== undefined) return value;
  const former = formerEnvName(name);
  return former === undefined ? undefined : process.env[former] ?? parseEnvFile()[former];
}

/**
 * Get an env value under its current name, else under a former name that the installation
 * settings list for it (`envAliases`), or undefined.
 */
export function getRenamedEnvKey(name: string): string | undefined {
  const current = getEnvKey(name);
  if (current !== undefined) return current;
  for (const former of formerVariableNames(name)) {
    const value = getEnvKey(former);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Get an env value or throw a clear error naming what is missing. */
export function requireEnvKey(name: string): string {
  const v = getEnvKey(name);
  if (!v) {
    throw new Error(
      `Missing ${describeProjectEnv(name)} — set it in the environment, the team env, or a repo-root .env file.`,
    );
  }
  return v;
}
