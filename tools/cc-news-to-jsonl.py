#!/usr/bin/env python3
"""
Stream Common Crawl CC-NEWS WARC files for a date range, extract English news
article text + the crawl timestamp, and write per-WARC corpus JSONL shards.
Parallel across CPU cores (one WARC per worker).

RUN THIS ON AN EC2 INSTANCE (any region — data is fetched over HTTPS from
data.commoncrawl.org, which is anonymous and free as EC2 inbound traffic). The
commoncrawl S3 bucket does NOT allow anonymous access, so we use HTTPS.

Resumability: each input WARC -> one output file out/<YYYY-MM>/<warc>.jsonl.gz.
Re-running skips any WARC whose output already exists (e.g. after a spot reclaim);
both .jsonl.gz and the older uncompressed .jsonl count as done.

Output is gzipped because the ingest step (src/corpus/ingest-ccnews.ts) only picks up
*.jsonl.gz. Writing plain .jsonl used to leave a gzip step that was easy to forget, and
forgetting it made the ingest report "0 shards" and exit successfully.

crawlDate = the WARC-Date header (when the crawler physically captured the page) —
the only correct "frozen" timestamp for time isolation. Output schema matches the
bench ingest format: {url, title, body, crawlDate}.

Dependencies (see docs/design/raven-bench/07-phase2-aws-runbook.md):
  pip install fastwarc resiliparse fasttext-wheel "numpy<2"   # numpy<2 is REQUIRED:
  # fasttext-wheel's predict() uses np.array(copy=False), which raises on NumPy 2.x.
  + fasttext language-id model lid.176.bin (~126 MB)

Usage:
  python3 cc-news-to-jsonl.py --start 2024-09 --end 2025-10 --out ./shards \
      --lid ./lid.176.bin [--workers N] [--limit-files N] [--max-records-per-file N]

Smoke test (1 file, capped records):
  python3 cc-news-to-jsonl.py --start 2025-02 --end 2025-02 --out ./shards \
      --lid ./lid.176.bin --limit-files 1
"""
import argparse
import gzip
import json
import os
import sys
import time
import urllib.request
from multiprocessing import Pool

from fastwarc.warc import ArchiveIterator, WarcRecordType
from resiliparse.parse.html import HTMLTree
from resiliparse.extract.html2text import extract_plain_text

PREFIX = "crawl-data/CC-NEWS"
CC_HTTPS = "https://data.commoncrawl.org"

_LID = None  # per-worker fasttext model (loaded once in pool initializer)


def http_get(url: str, timeout: int = 120):
    req = urllib.request.Request(url, headers={"User-Agent": "raven-bench-ccnews/1.0"})
    return urllib.request.urlopen(req, timeout=timeout)


def months_in_range(start: str, end: str):
    sy, sm = map(int, start.split("-"))
    ey, em = map(int, end.split("-"))
    y, m = sy, sm
    while (y, m) <= (ey, em):
        yield f"{y:04d}/{m:02d}"
        m = 1 if m == 12 else m + 1
        y = y + 1 if m == 1 else y


def list_warcs(ym: str):
    """Return CC-NEWS WARC keys for YYYY/MM from the published warc.paths.gz."""
    url = f"{CC_HTTPS}/{PREFIX}/{ym}/warc.paths.gz"
    try:
        with http_get(url, timeout=60) as r:
            data = gzip.decompress(r.read()).decode("utf-8")
    except Exception as e:
        print(f"  [{ym}] no warc.paths.gz ({e}); skipping", file=sys.stderr)
        return []
    return sorted(line.strip() for line in data.splitlines() if line.strip().endswith(".warc.gz"))


def is_english(text: str) -> bool:
    sample = text[:1000].replace("\n", " ")
    if not sample.strip():
        return False
    label, prob = _LID.predict(sample)
    return label[0] == "__label__en" and prob[0] >= 0.5


def _init_worker(lid_path: str):
    global _LID
    import fasttext
    _LID = fasttext.load_model(lid_path)


def process_warc(key: str, out_path: str, min_chars: int, max_records: int, download_bytes_per_second: int = 0) -> int:
    """Download one WARC over HTTPS (to a temp next to the output, on the data disk),
    extract English articles, write out_path atomically. Returns doc count."""
    tmp = out_path + ".warc.tmp"
    with http_get(f"{CC_HTTPS}/{key}", timeout=600) as r, open(tmp, "wb") as f:
        started = time.monotonic()
        copied = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            copied += len(chunk)
            if download_bytes_per_second > 0:
                pause = copied / download_bytes_per_second - (time.monotonic() - started)
                if pause > 0:
                    time.sleep(pause)
    n = 0
    seen = 0
    try:
        # Write .jsonl.gz, not .jsonl: the ingest script src/corpus/ingest-ccnews.ts reads only
        # .jsonl.gz. This used to write uncompressed files, which left a gzip step in between;
        # on 2026-09-06 the ingest then found no shards and exited successfully reporting
        # "0 shards". Writing the compressed format directly removes the step that was missed.
        with gzip.open(out_path + ".partial", "wt", encoding="utf-8") as fout, open(tmp, "rb") as fin:
            for record in ArchiveIterator(fin, record_types=WarcRecordType.response):
                seen += 1
                if max_records and seen > max_records:
                    break
                ctype = record.http_headers.get("Content-Type", "") if record.http_headers else ""
                if "html" not in ctype.lower():
                    continue
                url = record.headers.get("WARC-Target-URI", "")
                crawl_date = record.headers.get("WARC-Date", "")
                if not url or not crawl_date:
                    continue
                body_bytes = record.reader.read()
                if not body_bytes:
                    continue
                try:
                    tree = HTMLTree.parse_from_bytes(body_bytes)
                    title = (tree.title or "").strip()
                    text = extract_plain_text(tree, main_content=True, preserve_formatting=False)
                except Exception:
                    continue
                text = (text or "").strip()
                if len(text) < min_chars or not is_english(text):
                    continue
                # U+2028/U+2029 are valid in JSON strings (Python writes them raw)
                # but break line-based readers (Node readline splits on them). Strip.
                title = title.replace("\u2028", " ").replace("\u2029", " ")
                text = text.replace("\u2028", " ").replace("\u2029", " ")
                fout.write(json.dumps({
                    "url": url, "title": title, "body": text, "crawlDate": crawl_date,
                }, ensure_ascii=False) + "\n")
                n += 1
        os.replace(out_path + ".partial", out_path)  # only a complete file counts as done
    finally:
        for p in (tmp,):
            if os.path.exists(p):
                os.remove(p)
    return n


def _work(task):
    key, out_path, min_chars, max_records = task
    try:
        return key, process_warc(key, out_path, min_chars, max_records), None
    except Exception as e:
        # leave no stale .partial behind
        for p in (out_path + ".partial", out_path + ".warc.tmp"):
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        return key, 0, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, help="YYYY-MM inclusive")
    ap.add_argument("--end", required=True, help="YYYY-MM inclusive")
    ap.add_argument("--out", required=True)
    ap.add_argument("--lid", required=True, help="path to fasttext lid.176.bin")
    ap.add_argument("--workers", type=int, default=0, help="parallel workers (0 = all CPUs)")
    ap.add_argument("--limit-files", type=int, default=0, help="process at most N WARC files (0=all)")
    ap.add_argument("--max-records-per-file", type=int, default=0, help="examine <=N records/WARC (0=all)")
    ap.add_argument("--min-chars", type=int, default=200)
    args = ap.parse_args()

    # Build the task list (skip already-finished outputs → resumable).
    tasks = []
    for ym in months_in_range(args.start, args.end):
        keys = list_warcs(ym)
        month_dir = os.path.join(args.out, ym.replace("/", "-"))
        os.makedirs(month_dir, exist_ok=True)
        present = 0
        for key in keys:
            out_path = os.path.join(month_dir, os.path.basename(key).replace(".warc.gz", ".jsonl.gz"))
            # Both suffixes count as done. Output changed from .jsonl to .jsonl.gz on 2026-09-06;
            # accepting only the new suffix would re-download the hundreds of WARCs already
            # processed then, 1 GB each.
            if os.path.exists(out_path) or os.path.exists(out_path[: -len(".gz")]):
                present += 1
                continue
            tasks.append((key, out_path, args.min_chars, args.max_records_per_file))
            if args.limit_files and len(tasks) >= args.limit_files:
                break
        print(f"[{ym}] {len(keys)} files ({present} already done)", file=sys.stderr, flush=True)
        if args.limit_files and len(tasks) >= args.limit_files:
            break

    workers = args.workers or os.cpu_count() or 4
    print(f"Processing {len(tasks)} WARC files with {workers} workers...", file=sys.stderr, flush=True)

    start = time.time()
    files_done = 0
    docs_total = 0
    errors = 0
    with Pool(workers, initializer=_init_worker, initargs=(args.lid,)) as pool:
        for key, n, err in pool.imap_unordered(_work, tasks):
            files_done += 1
            if err:
                errors += 1
                print(f"  ERR {os.path.basename(key)}: {err}", file=sys.stderr, flush=True)
            else:
                docs_total += n
            if files_done % 25 == 0 or files_done == len(tasks):
                el = time.time() - start
                rate = files_done / el * 3600
                print(f"  {files_done}/{len(tasks)} files | {docs_total:,} EN docs | "
                      f"{errors} errs | {el/60:.1f} min | {rate:.0f} files/h", file=sys.stderr, flush=True)

    print(json.dumps({"files": files_done, "docs": docs_total, "errors": errors,
                      "elapsed_s": round(time.time() - start, 1)}))


if __name__ == "__main__":
    main()
