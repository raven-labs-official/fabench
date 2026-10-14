import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('source_library', Path(__file__).with_name('source-library.py'))
library = importlib.util.module_from_spec(spec); spec.loader.exec_module(library)


class SourceLibraryTest(unittest.TestCase):
    def test_directory_is_discovery_only_and_resolves_publisher_links(self):
        raw = b'<a href="/files/q1.pdf">Fiscal 2026 Q1</a><a href="javascript:bad">report</a><a href="/privacy">Privacy</a>'
        result = library.directory(raw, 'https://issuer.test/results/', 'html')
        self.assertEqual(len(result['candidates']), 1)
        self.assertEqual(result['candidates'][0]['url'], 'https://issuer.test/files/q1.pdf')
        self.assertEqual(result['candidates'][0]['availability'], 'unreviewed')

    def test_plan_preserves_all_questions_and_explicit_source_gaps(self):
        questions = [{'question_id': 'a', 'question_text': 'Orion FY2026 Q1 revenue?', 'as_of_date': '2026-03-01T00:00:00Z'},
                     {'question_id': 'b', 'question_text': 'Unknown issuer', 'as_of_date': '2026-03-01T00:00:00Z'}]
        rows = library.worklist(questions, [{'question_id': 'a', 'titles': ['Orion']}], [{'publisher': 'Orion', 'aliases': ['Orion']}])['rows']
        self.assertEqual(rows[0]['status'], 'directory-discovery')
        self.assertEqual(rows[1]['status'], 'publisher-needed')
        self.assertIn('FY2026 Q1', rows[0]['period_mentions'])


if __name__ == '__main__': unittest.main()
