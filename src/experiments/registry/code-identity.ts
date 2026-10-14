/** Code identity recorded with every registered run. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeCommit, executionSourceFiles } from "../../code-version.js";

/** Hash execution-relevant source, including uncommitted and untracked source files. */
export function experimentCodeIdentity(cwd = process.cwd()): {
  git_commit: string | null;
  source_fingerprint_sha256: string;
} {
  const files = executionSourceFiles(cwd);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    try {
      hash.update(readFileSync(join(cwd, file)));
    } catch {
      hash.update("[unreadable]");
    }
    hash.update("\0");
  }
  return {
    git_commit: codeCommit(cwd),
    source_fingerprint_sha256: hash.digest("hex"),
  };
}
