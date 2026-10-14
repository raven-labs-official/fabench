import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { FrozenIndexMetadata } from './frozen-index.js';
import { CORPUS_COMPACTION_TABLE } from './compaction.js';

/** Cheap treatment identity for the registry; never described as a whole-file checksum.
 * A frozen index verifies document bytes when serving them. Ordinary corpus integrity
 * still relies on the separately admitted immutable corpus/build manifest.
 */
export function corpusRetrievalIdentity(path: string) {
  const canonicalPath = realpathSync(path);
  const before = statSync(canonicalPath);
  const file = { path: canonicalPath, size_bytes: before.size, mtime_ms: before.mtimeMs };
  const db = new DatabaseSync(canonicalPath, { readOnly: true });
  try {
    const frozen = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='frozen_index_metadata'").get();
    if (!frozen) return { schema: 'raven.corpus-treatment.v1', kind: 'ordinary-sqlite-corpus', file };
    const row = db.prepare('SELECT json FROM frozen_index_metadata WHERE id=1').get() as { json: string } | undefined;
    const meta: FrozenIndexMetadata | null = row ? JSON.parse(row.json) : null;
    if (meta?.schema !== 'raven.frozen-index.v1' || meta.status !== 'complete')
      throw new Error('cannot identify an incomplete frozen index as an experiment treatment');
    const source = statSync(meta.source.path);
    if (source.size !== meta.source.size || source.mtimeMs !== meta.source.mtimeMs)
      assertSourceOnlyGrewAfterAnchor(meta, source.size);
    return {
      schema: 'raven.corpus-treatment.v1', kind: 'historical-fts-index', file,
      anchor: meta.anchor, documents: meta.documents, source: meta.source,
      build_metadata_sha256: createHash('sha256').update(row!.json).digest('hex'),
    };
  } finally {
    db.close();
    const after = statSync(canonicalPath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('corpus changed while deriving retrieval treatment identity');
  }
}

/** The shared corpus is append-only: newer CC-News captures are ingested behind the rows the
 * index was built from. Rows captured at or after the anchor can never enter this index, so
 * the treatment is unchanged as long as the pre-anchor rows the build saw are all still there
 * and no pre-anchor row appeared behind the build's last id. Both checks use idx_docs_crawl_ms;
 * served documents are still verified byte-for-byte by the frozen index itself.
 *
 * The file may shrink only after a verified compaction: the rewrite keeps every row and id,
 * stores bodies encoded, and records a receipt covering at least the build's last id. */
export function assertSourceOnlyGrewAfterAnchor(meta: FrozenIndexMetadata, sizeNow: number, sourcePath = meta.source.path) {
  const anchorMs = Date.parse(meta.anchor);
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    if (sizeNow < meta.source.size) {
      const receipts = src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(CORPUS_COMPACTION_TABLE);
      const covered = receipts && src.prepare(`SELECT 1 FROM ${CORPUS_COMPACTION_TABLE} WHERE max_id >= ? LIMIT 1`).get(meta.lastId);
      if (!covered) throw new Error('frozen index source identity changed: source shrank');
    }
    const gained = src.prepare('SELECT 1 FROM docs WHERE crawl_ms < ? AND id > ? LIMIT 1').get(anchorMs, meta.lastId);
    if (gained) throw new Error('frozen index source identity changed: pre-anchor documents were added after the build; rebuild the index');
    const kept = src.prepare('SELECT count(*) AS n FROM docs WHERE crawl_ms < ? AND id <= ?').get(anchorMs, meta.lastId) as { n: number };
    if (kept.n !== meta.documents)
      throw new Error(`frozen index source identity changed: ${kept.n} pre-anchor documents remain of ${meta.documents} indexed; rebuild the index`);
  } finally { src.close(); }
}
