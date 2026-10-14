#!/usr/bin/env python3
"""Verify the retrieval dependency and benchmark linking entry points.

The dependency is either the pinned Git submodule (this repository) or, in a source tree
exported without history, a plain directory described by vendor/retrieval-infra.vendored.json.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
VENDORED = 'vendor/retrieval-infra.vendored.json'


def git(cwd, *args):
    # Trust these explicit project paths, including group-owned releases.
    return subprocess.check_output(
        ['git', '-c', f'safe.directory={cwd}', '-C', str(cwd), *args], text=True,
    ).strip()


def verify_submodule(root, target):
    entry = git(root, 'ls-files', '--stage', '--', 'vendor/retrieval-infra').split()
    assert len(entry) == 4 and entry[0] == '160000' and entry[2] == '0', 'retrieval infra must be an unconflicted Git submodule'
    cache = json.loads((root / 'vendor/retrieval-infra.cache.json').read_text())
    assert cache['schema'] == 'raven.infra-cache.v1' and cache['commit'] == entry[1], 'dependency cache differs from Git pin'
    assert (target / '.git').exists(), 'run git submodule update --init --recursive'
    assert git(target, 'rev-parse', 'HEAD') == entry[1], 'submodule HEAD differs from the staged Git pin'
    assert not git(target, 'status', '--porcelain'), 'retrieval submodule has uncommitted changes'
    return f'verified retrieval submodule {entry[1]}'


def verify_vendored(root, target):
    record = json.loads((root / VENDORED).read_text())
    assert record.get('schema') == 'raven.infra-vendored.v1', 'unknown vendored dependency record'
    assert isinstance(record.get('commit'), str) and len(record['commit']) == 40, 'vendored record names no source commit'
    assert not (target / '.git').exists(), 'a vendored dependency is a plain directory, not a Git checkout'
    return f'verified vendored retrieval source {record["commit"]}'


def verify_links(root, target):
    assert json.loads((target / 'package.json').read_text())['name'] == '@fabench/retrieval-infra'
    manifest = json.loads((root / 'vendor/retrieval-infra.links.json').read_text())
    assert manifest['schema'] == 'raven.infra-links.v1'
    for name in manifest['forwarders']:
        path = root / name
        relative = os.path.relpath(target / name, path.parent).removesuffix('.ts') + '.js'
        expected = '// Retrieval implementation is maintained in the pinned Git submodule.\nexport * from ' + json.dumps(relative) + ';\n'
        assert path.read_text() == expected, f'entry point contains a local implementation: {name}'
    for name in manifest['tools']:
        path = root / name
        assert path.is_symlink() and path.resolve() == (target / name).resolve(), f'expected a link to upstream: {name}'
        assert path.is_file(), f'missing upstream link target: {name}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT, help=argparse.SUPPRESS)
    root = parser.parse_args().root.resolve()
    target = root / 'vendor/retrieval-infra'
    message = verify_vendored(root, target) if (root / VENDORED).exists() else verify_submodule(root, target)
    verify_links(root, target)
    print(message)


if __name__ == '__main__':
    main()
