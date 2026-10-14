"""Deterministic JSON artifacts used by catalog exporters."""
import hashlib
import json
from pathlib import Path


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def write_jsonl(path, rows):
    Path(path).write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows))


def file_sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()
