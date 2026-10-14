/**
 * Project environment variables are named FABENCH_*. Their former names, RAVEN_*, are still
 * read when the new name is unset, so existing deployment env files keep working unchanged.
 *
 * "Unset" means absent: a new name set to the empty string is used as written and does not
 * fall back, so a caller can still clear a setting for a child process.
 */
export const ENV_PREFIX = "FABENCH_";
export const FORMER_ENV_PREFIX = "RAVEN_";

type Environment = Record<string, string | undefined>;

/** The former name of a project variable (FABENCH_X → RAVEN_X), or undefined for other names. */
export function formerEnvName(name: string): string | undefined {
  return name.startsWith(ENV_PREFIX) ? FORMER_ENV_PREFIX + name.slice(ENV_PREFIX.length) : undefined;
}

/** The name a value is read from: `name` when it is set, else its former name when that is set. */
export function projectEnvName(name: string, env: Environment = process.env): string {
  if (env[name] !== undefined) return name;
  const former = formerEnvName(name);
  return former !== undefined && env[former] !== undefined ? former : name;
}

/** The value of `name`, or of its former name when `name` is unset. */
export function projectEnv(name: string, env: Environment = process.env): string | undefined {
  return env[projectEnvName(name, env)];
}

/** Remove `name` and its former name, so neither is inherited by a later read. */
export function clearProjectEnv(name: string, env: Environment = process.env): void {
  delete env[name];
  const former = formerEnvName(name);
  if (former !== undefined) delete env[former];
}

/** `name`, followed by "(or NAME)" for its former name, for messages that tell a user what to set. */
export function describeProjectEnv(name: string): string {
  const former = formerEnvName(name);
  return former === undefined ? name : `${name} (or the former ${former})`;
}
