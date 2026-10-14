/**
 * Fail clearly when the corpus file is not where the environment says it is.
 *
 * The index is 150 GiB and lives outside the repository, on a mounted disk or an object
 * store. When that path is wrong the failures downstream are unhelpful — SQLite says "unable
 * to open database file", which does not say which file or who was supposed to provide it.
 *
 * This replaces an earlier check on a `data` symlink, which stopped meaning anything once the
 * path came from FABENCH_CORPUS_DB: the guard would refuse to run because a directory it no
 * longer used was absent.
 */
import { existsSync, statSync } from "node:fs";

export function assertCorpusAvailable(path: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `Corpus not found: ${path}\n` +
        `  FABENCH_CORPUS_DB must point at the frozen corpus SQLite file.\n` +
        `  It is not in the repository — 150 GiB — so it is mounted or downloaded separately.`,
    );
  }
  const st = statSync(path);
  if (st.isDirectory()) {
    throw new Error(`Corpus path is a directory, expected a SQLite file: ${path}`);
  }
  // A few hundred bytes means an empty or truncated file — worth catching here rather than as
  // "no such table: docs" three frames deeper.
  if (st.size < 1_000_000) {
    throw new Error(`Corpus file is only ${st.size} bytes, which cannot be a built index: ${path}`);
  }
}
