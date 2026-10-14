"""The retrieval dependency check also accepts a plain vendored directory (exported source tree)."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

VERIFY = Path(__file__).with_name('verify-retrieval-infra.py')


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


class VendoredRetrievalTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='fabench-vendored-'))
        self.addCleanup(shutil.rmtree, self.root, True)
        infra = self.root / 'vendor/retrieval-infra'
        write(infra / 'package.json', json.dumps({'name': '@fabench/retrieval-infra'}))
        write(infra / 'src/example.ts', 'export const value = 1;\n')
        write(infra / 'tools/helper.py', 'print("helper")\n')
        write(self.root / 'src/example.ts',
              '// Retrieval implementation is maintained in the pinned Git submodule.\n'
              'export * from "../vendor/retrieval-infra/src/example.js";\n')
        (self.root / 'tools').mkdir()
        (self.root / 'tools/helper.py').symlink_to('../vendor/retrieval-infra/tools/helper.py')
        write(self.root / 'vendor/retrieval-infra.links.json', json.dumps({
            'schema': 'raven.infra-links.v1', 'forwarders': ['src/example.ts'], 'tools': ['tools/helper.py']}))
        write(self.root / 'vendor/retrieval-infra.vendored.json', json.dumps({
            'schema': 'raven.infra-vendored.v1', 'commit': 'a' * 40}))

    def verify(self):
        return subprocess.run([sys.executable, str(VERIFY), '--root', str(self.root)], capture_output=True, text=True)

    def test_plain_directory_with_record_and_links_passes(self):
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('verified vendored retrieval source ' + 'a' * 40, result.stdout)

    def test_local_implementation_in_a_forwarder_fails(self):
        write(self.root / 'src/example.ts', 'export const value = 2;\n')
        self.assertNotEqual(self.verify().returncode, 0)

    def test_record_without_commit_fails(self):
        write(self.root / 'vendor/retrieval-infra.vendored.json', json.dumps({'schema': 'raven.infra-vendored.v1'}))
        self.assertNotEqual(self.verify().returncode, 0)


if __name__ == '__main__':
    unittest.main()
