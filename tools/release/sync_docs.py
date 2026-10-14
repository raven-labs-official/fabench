#!/usr/bin/env python3
"""Keep the shared sections of the GitHub README and the Hugging Face dataset card identical.

    python3 tools/release/sync_docs.py --check   # exit 1 if a shared section differs
    python3 tools/release/sync_docs.py --write   # copy every shared section from the README into the card

The README is the source. Each shared section sits between `<!-- shared:NAME -->` and
`<!-- /shared:NAME -->`. The dataset card (dataset/README.md) carries the same markers, and its copy of
each section must match the README's byte for byte. In the team repository the two files are
docs/public/README.md and docs/public/dataset/README.md. Edit a shared section in the README,
run --write, and commit both files. tools/test_sync_docs.py runs --check in CI.
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# The public repository keeps the files at its root; the team repository keeps them under docs/public/.
BASE = ROOT / 'docs/public' if (ROOT / 'docs/public/README.md').exists() else ROOT
SOURCE = BASE / 'README.md'
COPIES = [BASE / 'dataset/README.md']
BLOCK = re.compile(r'<!-- shared:([a-z0-9-]+) -->\n(.*?)<!-- /shared:\1 -->', re.S)


def blocks(text: str) -> dict[str, str]:
    found = {}
    for match in BLOCK.finditer(text):
        if match.group(1) in found:
            raise SystemExit(f'shared section {match.group(1)} appears twice')
        found[match.group(1)] = match.group(2)
    return found


def problems(source: str, copy: str, name: str) -> list[str]:
    wanted, have = blocks(source), blocks(copy)
    out = [f'{name}: shared section {key} is missing' for key in wanted if key not in have]
    out += [f'{name}: shared section {key} is not in the README' for key in have if key not in wanted]
    out += [f'{name}: shared section {key} differs from the README'
            for key in wanted if key in have and have[key] != wanted[key]]
    return out


def synced(source: str, copy: str) -> str:
    wanted = blocks(source)
    return BLOCK.sub(lambda m: f'<!-- shared:{m.group(1)} -->\n{wanted.get(m.group(1), m.group(2))}'
                               f'<!-- /shared:{m.group(1)} -->', copy)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--write', action='store_true')
    args = ap.parse_args()
    source = SOURCE.read_text()
    found = []
    for path in COPIES:
        copy = path.read_text()
        if args.write:
            path.write_text(synced(source, copy))
            copy = path.read_text()
        found += problems(source, copy, str(path.relative_to(ROOT)))
    for line in found:
        print(line, file=sys.stderr)
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main())
