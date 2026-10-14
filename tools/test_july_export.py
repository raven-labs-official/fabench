import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    'july_export', ROOT / 'question-making/july-0917/scripts/export_platform_files.py')
july_export = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(july_export)

ASOF = '2026-07-01T00:00:00Z'
TEMPLATE = 'Information as-of date (UTC): {as_of_date}\nPrediction cutoff (UTC): {prediction_cutoff_utc}\nTarget period: {target_period_en}\n\nQuestion:\n{question_en}\n{resolution_criteria_en}'


def row(qid, unit=None, numeric=None, active=True, params=True):
    params_value = dict(as_of_date=ASOF, prediction_cutoff_utc='2026-08-01T03:59:59Z', target_period_en='July 2026',
                        question_en=f'Question {qid}?', resolution_criteria_en='Resolve Yes if it happens.')
    q = dict(id=qid, active=active, admission={'status': 'usable' if active else 'discarded'}, cut_off_time=ASOF,
             timing={'forecast_as_of_utc': ASOF, 'prediction_cutoff_utc': '2026-08-01T03:59:59Z',
                     'prediction_cutoff_role': 'event_deadline', 'target_period_en': 'July 2026'},
             question_en=f'Question {qid}?', question_zh='问题', resolution_criteria_en='Resolve Yes if it happens.',
             category={'id': 'economy'}, prediction_spec={'numeric_target': {'unit': unit} if unit else None},
             resolution_date='2026-08-05', resolution_result=1, numeric_result=numeric,
             model_input_en=TEMPLATE.format(**params_value))
    if params:
        q['prompt_parameters'] = params_value
    return q


class JulyExportTest(unittest.TestCase):
    def write(self, directory, questions):
        path = Path(directory) / 'author.json'
        path.write_text(json.dumps({'information_as_of_utc': ASOF, 'question_version': 'test', 'release_status': 'DRAFT',
                                    'prompt_templates': {'template_en': TEMPLATE}, 'questions': questions}))
        return path

    def test_usable_rows_are_split_and_scalar_numeric_results_gain_their_unit(self):
        with tempfile.TemporaryDirectory() as directory:
            author = self.write(directory, [row('E1'), row('N1', 'percent', 2.5, params=False),
                                            row('N2', 'USD', {'value': 3, 'unit': 'USD'}), row('X1', active=False)])
            stats = july_export.export(author, Path(directory) / 'out', prefix='t')
            models = [json.loads(line) for line in (Path(directory) / 'out/t-model-test.jsonl').read_text().splitlines()]
            grades = [json.loads(line) for line in (Path(directory) / 'out/t-grading-key.jsonl').read_text().splitlines()]
            self.assertEqual([m['id'] for m in models], ['E1', 'N1', 'N2'])
            self.assertTrue(all('resolution_result' not in m and 'numeric_result' not in m for m in models))
            self.assertEqual(grades[1]['numeric_result'], {'value': 2.5, 'unit': 'percent'})
            self.assertEqual(stats['scalar_numeric_results_wrapped'], ['N1'])
            self.assertEqual(stats['prompts_without_template_parameters'], ['N1'])
            self.assertEqual(models[0]['cut_off_time'], ASOF)

    def test_unit_mismatch_and_pre_anchor_resolution_stop_the_export(self):
        for bad in [row('N1', 'percent', {'value': 1, 'unit': 'USD'}), dict(row('E1'), resolution_date='2026-06-30')]:
            with tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(AssertionError):
                    july_export.export(self.write(directory, [bad]), Path(directory) / 'out')


if __name__ == '__main__':
    unittest.main()
