import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('sync_docs', ROOT / 'tools/release/sync_docs.py')
sync_docs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync_docs)

README = sync_docs.SOURCE
CARD = sync_docs.COPIES[0]


class SharedSections(unittest.TestCase):
    def setUp(self):
        if not README.exists() or not CARD.exists():
            self.skipTest('the README and the dataset card are not in this tree')

    def test_the_dataset_card_matches_the_readme(self):
        self.assertEqual(sync_docs.problems(README.read_text(), CARD.read_text(), 'card'), [])
        self.assertGreaterEqual(len(sync_docs.blocks(README.read_text())), 4)

    def test_a_changed_section_is_reported_and_rewritten(self):
        source = '<!-- shared:a -->\nnew\n<!-- /shared:a -->\n'
        copy = 'head\n<!-- shared:a -->\nold\n<!-- /shared:a -->\ntail\n'
        self.assertEqual(sync_docs.problems(source, copy, 'card'), ['card: shared section a differs from the README'])
        self.assertEqual(sync_docs.synced(source, copy), 'head\n<!-- shared:a -->\nnew\n<!-- /shared:a -->\ntail\n')
        self.assertEqual(sync_docs.problems(source, 'no markers', 'card'), ['card: shared section a is missing'])


if __name__ == '__main__':
    unittest.main()
