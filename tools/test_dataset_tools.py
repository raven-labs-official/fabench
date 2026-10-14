"""Tests of the tools that read the released dataset: corpus-from-parquet.py and from-dataset.py."""
import datetime as dt
import hashlib
import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
except ImportError:  # pragma: no cover - the tools need pyarrow (requirements-dev.txt)
    pa = None

TOOLS = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), TOOLS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def corpus_row(doc_id, body, crawl_date):
    url, title = f'https://example.org/{doc_id}', f'Title {doc_id}'
    capture = json.dumps([url, title, body, crawl_date], ensure_ascii=False, separators=(',', ':'))
    return dict(doc_id=doc_id, url=url, title=title, body=body, crawl_date=crawl_date,
                acquired_at=dt.datetime.fromisoformat(crawl_date.replace('Z', '+00:00')),
                wire=None, source='ccnews', body_sha256=hashlib.sha256(body.encode()).hexdigest(),
                capture_sha256=hashlib.sha256(capture.encode()).hexdigest())


@unittest.skipIf(pa is None, 'pyarrow is not installed')
class CorpusFromParquetTest(unittest.TestCase):
    def test_capture_hash_matches_json_stringify(self):
        # JSON.stringify of this array, hashed with Node, gives the expected digest.
        value = ['https://example.org/a?b=1&c=é', 'Title "quoted" \\ back',
                 'Body line para\ttab\nnew \u0001ctl \u007f del café \U0001F600 </script>',
                 '2026-06-30T23:59:55Z']
        self.assertEqual(load('corpus-from-parquet').capture_hash(*value),
                         'a099e4da69b9d5e76a50c3e81f338c90c2555afe35c611d2df05d10c8776a154')

    def run_tool(self, out, *args):
        return subprocess.run([sys.executable, str(TOOLS / 'corpus-from-parquet.py'), '--out', str(out), *map(str, args)],
                              capture_output=True, text=True)

    def test_loads_filters_resumes_and_rejects_changed_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rows = [corpus_row(5, 'early café', '2026-05-31T23:59:59Z'),
                    corpus_row(9, 'at the anchor', '2026-06-01T00:00:00Z'),
                    corpus_row(12, 'later', '2026-06-30T02:27:34Z')]
            schema = pa.schema([('doc_id', pa.int64()), ('url', pa.string()), ('title', pa.string()),
                                ('body', pa.string()), ('crawl_date', pa.string()),
                                ('acquired_at', pa.timestamp('ms', 'UTC')), ('wire', pa.string()),
                                ('source', pa.string()), ('body_sha256', pa.string()), ('capture_sha256', pa.string())])
            shard = tmp / 'part-00000-of-00001.parquet'
            pq.write_table(pa.Table.from_pylist(rows, schema), shard, row_group_size=2)

            early = tmp / 'early.db'
            self.assertEqual(self.run_tool(early, '--before', '2026-06-01T00:00:00Z', shard).returncode, 0)
            db = sqlite3.connect(early)
            self.assertEqual(db.execute('SELECT id, body, crawl_ms FROM docs').fetchall(),
                             [(5, 'early café', 1780271999000)])
            db.close()

            full = tmp / 'full.db'
            self.assertEqual(self.run_tool(full, shard).returncode, 0)
            again = self.run_tool(full, shard)
            self.assertIn('0 rows written, 3 already present', again.stderr)
            db = sqlite3.connect(full)
            self.assertEqual([r[0] for r in db.execute('SELECT id FROM docs ORDER BY id')], [5, 9, 12])
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0], 'delete')
            db.close()

            rows[1]['body'] = 'changed'
            pq.write_table(pa.Table.from_pylist(rows, schema), shard)
            changed = self.run_tool(tmp / 'changed.db', shard)
            self.assertNotEqual(changed.returncode, 0)
            self.assertIn('body_sha256 mismatch for doc_id 9', changed.stderr)


@unittest.skipIf(pa is None, 'pyarrow is not installed')
class FromDatasetTest(unittest.TestCase):
    def test_questions_keep_outcomes_and_mark_withheld_values(self):
        base = dict(anchor='2026-07-01', question_zh='问', as_of_utc='2026-07-01T00:00:00Z',
                    information_cutoff_utc='2026-07-01T00:00:00Z', prediction_cutoff_utc='2026-08-01T00:00:00Z',
                    prediction_cutoff_role='event_deadline', target_period_en='July 2026',
                    resolution_criteria_en='Criteria', category='finance', response_format='raven.forecast.v2.1',
                    model_prompt='Prompt', resolution_date='2026-07-20', resolution_result=1)
        questions = [
            dict(base, question_id='Q1', subset='a', question_en='Event?', numeric_target_unit=None,
                 numeric_result_json=None, numeric_result_withheld=False),
            dict(base, question_id='Q2', subset='a', question_en='Index level?', numeric_target_unit='index_points',
                 numeric_result_json=None, numeric_result_withheld=True),
            dict(base, question_id='Q3', subset='b', question_en='Rate?', numeric_target_unit='percent',
                 numeric_result_json='{"unit": "percent", "value": 4.1}', numeric_result_withheld=False),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / 'questions/july-2026-07-01').mkdir(parents=True)
            pq.write_table(pa.Table.from_pylist(questions), tmp / 'questions/july-2026-07-01/questions.parquet')
            subprocess.run([sys.executable, str(TOOLS / 'from-dataset.py'), 'questions', '--dataset', str(tmp),
                            '--subset', 'a', '--out-dir', str(tmp / 'out'), '--prefix', 'q'],
                           check=True, capture_output=True)
            model = [json.loads(line) for line in (tmp / 'out/q-model-test.jsonl').read_text().splitlines()]
            grades = [json.loads(line) for line in (tmp / 'out/q-grading-key.jsonl').read_text().splitlines()]
        self.assertEqual([q['id'] for q in model], ['Q1', 'Q2'])
        self.assertEqual(model[0]['data_contract'], 'raven.question.v3')
        self.assertEqual(model[0]['cut_off_time'], model[0]['as_of_date'])
        self.assertFalse(any('resolution_result' in q for q in model))
        self.assertEqual(grades[0], dict(id='Q1', resolution_date='2026-07-20', resolution_result=1, numeric_result=None))
        self.assertEqual(grades[1]['numeric_result'], None)
        self.assertIs(grades[1]['numeric_result_withheld'], True)


if __name__ == '__main__':
    unittest.main()
