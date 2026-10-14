import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { projectEnv } from "../env-names.js";

/** Where the optional ranking extension is looked for (native/raven_bm25.c; built by tools/build-native.sh). */
export function bm25ExtensionPath(): string | null {
  const configured = projectEnv("FABENCH_BM25_EXTENSION");
  if (configured !== undefined) return configured === '' ? null : configured;
  const built = fileURLToPath(new URL('../../native/build/raven_bm25.so', import.meta.url));
  return existsSync(built) ? built : null;
}

/**
 * Loads bm25_cached() into a read-only frozen index connection when the extension is built.
 * It ranks exactly like FTS5's bm25() but remembers how many rows contain each phrase, which
 * the frozen index never changes; without it the built-in bm25() is used, with identical
 * results. Extension loading is switched off again either way.
 */
export function loadCachedBm25(db: DatabaseSync): boolean {
  const path = bm25ExtensionPath();
  try {
    if (!path) return false;
    db.loadExtension(path);
    return true;
  } finally {
    db.enableLoadExtension(false);
  }
}
