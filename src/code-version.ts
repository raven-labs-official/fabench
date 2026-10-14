import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RELEASE_COMMIT_FILE = join(".git", "raven-release-commit");
const RELEASE_FILES_FILE = join(".git", "raven-release-files");
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const SOURCE_PATHS = ["src", "tools", "vendor", "package.json", "pnpm-lock.yaml", ".gitmodules"];

export function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Read release metadata without invoking Git, which may reject a group-owned checkout. */
export function releaseCommit(cwd: string): string | null {
  try {
    const value = readFileSync(join(cwd, RELEASE_COMMIT_FILE), "utf8").trim();
    return FULL_GIT_SHA.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function releaseTrackedFiles(cwd: string): string[] | null {
  try {
    const value = readFileSync(join(cwd, RELEASE_FILES_FILE), "utf8");
    return value.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

function isExecutionSource(file: string): boolean {
  return SOURCE_PATHS.some((path) => file === path || file.startsWith(`${path}/`));
}

/** Expand gitlinks so a changed retrieval implementation changes the run identity. */
function gitSourceFiles(cwd: string, prefix = ""): string[] | null {
  // An uninitialized submodule directory can otherwise run Git against its parent.
  if (prefix && gitOutput(cwd, ["rev-parse", "--show-prefix"]) !== "") return null;
  const pathspec = prefix ? [] : ["--", ...SOURCE_PATHS];
  const tracked = gitOutput(cwd, ["ls-files", "--stage", "-z", ...pathspec]);
  const untracked = gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec]);
  if (tracked === null || untracked === null) return null;
  const files = new Set<string>();
  for (const record of tracked.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) return null;
    const file = record.slice(tab + 1);
    if (record.startsWith("160000 ")) {
      const nested = gitSourceFiles(join(cwd, file), `${prefix}${file}/`);
      if (nested === null) return null;
      for (const nestedFile of nested) files.add(nestedFile);
    } else {
      files.add(`${prefix}${file}`);
    }
  }
  for (const file of untracked.split("\0").filter(Boolean)) files.add(`${prefix}${file}`);
  return [...files];
}

/** The release fallback contains recursively expanded paths, never gitlink directories. */
export function executionSourceFiles(cwd: string): string[] {
  return [...new Set(
    gitSourceFiles(cwd) ?? releaseTrackedFiles(cwd)?.filter(isExecutionSource) ?? [],
  )].sort();
}

export function codeCommit(cwd: string): string | null {
  return releaseCommit(cwd) ?? gitOutput(cwd, ["rev-parse", "HEAD"]);
}
