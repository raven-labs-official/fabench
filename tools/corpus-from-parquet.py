#!/usr/bin/env python3
"""Load released news-corpus Parquet shards into a corpus database for the frozen index.

    python tools/corpus-from-parquet.py --out corpus.db [--before 2026-07-01T00:00:00Z] SHARD.parquet ...

The shards are the `corpus/july-2026-07-01/` files of the FABench dataset (docs/reproduction.md).
Each row becomes one row of the corpus `docs` table (schema of src/corpus/store.ts) with the
released `doc_id` as its id, so ids match the paper's index and traces. Every row's
`body_sha256` and `capture_sha256` are checked before it is written; the frozen index stores
the same capture hash and re-checks it on every read.

The database is what vendor/retrieval-infra/tools/build-frozen-index.ts reads. It has no
full-text table of its own: the frozen index holds the searchable copy. Rows are committed one
Parquet row group at a time; re-running the same command after an interruption skips the row
groups already written. Do not modify the file after building an index from it: the index
records its size and modification time and refuses a changed source.
"""
import argparse
import datetime as dt
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

import pyarrow.compute as pc
import pyarrow.parquet as pq

# src/corpus/store.ts (vendor/retrieval-infra), without the full-text tables.
SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
  id        INTEGER PRIMARY KEY,
  url       TEXT NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT NOT NULL,
  crawl_date TEXT NOT NULL,
  crawl_ms  INTEGER NOT NULL,
  wire      TEXT,
  source    TEXT NOT NULL DEFAULT 'ccnews'
);
"""
INDEXES = """
CREATE INDEX IF NOT EXISTS idx_docs_crawl_ms ON docs(crawl_ms);
CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(source);
CREATE INDEX IF NOT EXISTS idx_docs_url ON docs(url);
"""
COLUMNS = ['doc_id', 'url', 'title', 'body', 'crawl_date', 'acquired_at', 'wire', 'source',
           'body_sha256', 'capture_sha256']


def capture_hash(url, title, body, crawl_date):
    """SHA-256 of JSON.stringify([url, title, body, crawl_date]), as the frozen index computes it."""
    text = json.dumps([url, title, body, crawl_date], ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def anchor_ms(text):
    return int(dt.datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp() * 1000)


def load(db, shard, before):
    parquet = pq.ParquetFile(shard)
    written = skipped = 0
    for group in range(parquet.num_row_groups):
        table = parquet.read_row_group(group, columns=COLUMNS)
        crawl_ms = pc.cast(table['acquired_at'], 'int64')
        if before is not None:
            keep = pc.less(crawl_ms, before)
            table, crawl_ms = table.filter(keep), crawl_ms.filter(keep)
        if table.num_rows == 0:
            continue
        last_id = pc.max(table['doc_id']).as_py()
        if db.execute('SELECT 1 FROM docs WHERE id=?', (last_id,)).fetchone():
            skipped += table.num_rows
            continue
        rows = []
        for r, ms in zip(table.to_pylist(), crawl_ms.to_pylist()):
            if hashlib.sha256(r['body'].encode('utf-8')).hexdigest() != r['body_sha256']:
                raise SystemExit(f'{shard}: body_sha256 mismatch for doc_id {r["doc_id"]}')
            if capture_hash(r['url'], r['title'], r['body'], r['crawl_date']) != r['capture_sha256']:
                raise SystemExit(f'{shard}: capture_sha256 mismatch for doc_id {r["doc_id"]}')
            rows.append((r['doc_id'], r['url'], r['title'], r['body'], r['crawl_date'], ms, r['wire'],
                         r['source']))
        with db:
            db.executemany('INSERT INTO docs (id, url, title, body, crawl_date, crawl_ms, wire, source) '
                           'VALUES (?, ?, ?, ?, ?, ?, ?, ?)', rows)
        written += len(rows)
    return written, skipped


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--out', required=True, type=Path, help='corpus database to create or resume')
    ap.add_argument('--before', help='keep only rows captured strictly before this UTC time, e.g. 2026-07-01T00:00:00Z')
    ap.add_argument('shards', nargs='+', type=Path, help='Parquet shards (corpus/july-2026-07-01/*.parquet)')
    args = ap.parse_args()
    before = anchor_ms(args.before) if args.before else None
    db = sqlite3.connect(args.out)
    db.executescript('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;' + SCHEMA)
    total = 0
    for shard in sorted(args.shards):
        written, skipped = load(db, shard, before)
        total += written
        print(f'{shard.name}: {written} rows written, {skipped} already present', file=sys.stderr)
    db.executescript(INDEXES)
    count = db.execute('SELECT count(*) FROM docs').fetchone()[0]
    db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    db.execute('PRAGMA journal_mode=DELETE')  # one self-contained file that read-only readers can open
    db.close()
    print(f'{args.out}: {count} documents ({total} written by this run)')


if __name__ == '__main__':
    main()
