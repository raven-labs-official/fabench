import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from reporting import combined as m


class CombinedTests(unittest.TestCase):
    def test_pools_errors_per_question_and_does_not_average_indices(self):
        old = [{'model': 'GPT-6 Astra', 'arm': 'none', 'answers': [
            {'question_id': 'a', 'probability': 1, 'outcome': 1},
            {'question_id': 'b', 'probability': 1, 'outcome': 1}]}]
        new = [{'model': 'GPT-6 Astra', 'arm': 'none', 'answers': [
            {'question_id': 'c', 'probability': 0, 'outcome': 1}]}]
        rows = m.combine(old, new, ['a', 'b'], ['c', 'd'])
        r = next(r for r in rows if r['model'] == 'GPT-6 Astra' and r['arm'] == 'none')
        self.assertEqual(r['n'], 3)
        self.assertAlmostEqual(r['brier'], 1 / 3)
        self.assertEqual(r['missing_ids'], ['d'])
        self.assertFalse(r['complete'])
        self.assertEqual(len(rows), 31)
        self.assertEqual({r['model'] for r in rows if r['model'] in ('Claude Opus 5.5', 'GPT-6 Sol')},
                         {'Claude Opus 5.5', 'GPT-6 Sol'})
        self.assertEqual([r['arm'] for r in rows if r['model'] == 'JEV 1.13.0'], ['none'])

    def test_mixed_only_adds_a_row_for_models_that_ran_it(self):
        old = [dict(model='DeepSeek Flash', arm='both', answers=[dict(question_id='a', probability=.8, outcome=1)])]
        rows = m.combine(old, [], ['a'], ['b'])
        mixed = [r for r in rows if r['arm'] == 'both']
        self.assertEqual(len(rows), 32)
        self.assertEqual([r['model'] for r in mixed], ['DeepSeek Flash'])
        self.assertEqual(mixed[0]['n'], 1)
        self.assertEqual(mixed[0]['missing_ids'], ['b'])

    def test_duplicate_or_invalid_probabilities_cannot_be_scored(self):
        with self.assertRaises(ValueError):
            m.combine([], [], ['a'], ['a'])
        with self.assertRaises(ValueError):
            m.metric([{'question_id': 'a', 'probability': None, 'outcome': 1}])
        a = {'question_id': 'a', 'probability': .5, 'outcome': 1}
        with self.assertRaises(ValueError):
            m.metric([a, a])

    def test_neutral_questions_only_add_one_identical_prefix(self):
        original = {'a': {'id': 'a', 'prompt': 'Make a forecast.', 'as_of': '2026-07-01'}}
        neutral = {'a': {'id': 'a', 'prompt': 'This is a benchmark. Make a forecast.', 'as_of': '2026-07-01'}}
        self.assertEqual(m.verify_alternate_questions(original, neutral, 'neutral'),
                         'This is a benchmark. ')
        wrong_cutoff = {'a': dict(neutral['a'], as_of='2026-07-02')}
        with self.assertRaisesRegex(ValueError, 'changed outside'):
            m.verify_alternate_questions(original, wrong_cutoff, 'neutral')
        with self.assertRaisesRegex(ValueError, 'changed outside'):
            m.verify_alternate_questions(original, neutral, 'xhigh')

    def test_neutral_fills_only_missing_strict_cells_and_keeps_provenance(self):
        row = dict(model='GPT-5.6 Sol', arm='frozen', expected=2,
                   answers=[dict(question_id='a', probability=0.2, outcome=1, mode='strict')],
                   no_probability_n=1, failure_categories={'b': 'no_probability'},
                   condition_ids=['codex:gpt-5.6-sol|strict'])
        selected = {
            ('neutral', 'frozen', 'a'): dict(question_id='a', probability=0.9, outcome=1,
                                          raw_model='codex:gpt-5.6-sol', condition_id='neutral'),
            ('neutral', 'frozen', 'b'): dict(question_id='b', probability=0.7, outcome=0,
                                          raw_model='codex:gpt-5.6-sol', condition_id='neutral',
                                          result_run_id='new-run', mode='prompt_fallback'),
        }
        updated = m.with_prompt_fallback(row, selected, {'a': {}, 'b': {}})
        self.assertEqual([(a['question_id'], a['probability']) for a in updated['answers']],
                         [('a', 0.2), ('b', 0.7)])
        self.assertEqual(updated['prompt_fallback_n'], 1)
        self.assertEqual(updated['no_probability_n'], 0)
        self.assertEqual(updated['n'], 2)
        self.assertEqual(updated['missing_ids'], [])
        self.assertIn('codex:gpt-5.6-sol|neutral', updated['condition_ids'])

    def test_neutral_none_fills_only_a_missing_cell(self):
        row = dict(model='GPT-5.6 Sol', arm='none', expected=2,
                   answers=[dict(question_id='a', probability=.2, outcome=1)],
                   no_probability_n=1, condition_ids=[])
        selected = {
            ('neutral', 'none', 'a'): dict(question_id='a', probability=.9, outcome=1),
            ('neutral', 'none', 'b'): dict(question_id='b', probability=.7, outcome=0,
                                      raw_model='codex:gpt-5.6-sol', condition_id='pilot',
                                      result_run_id='pilot-run', mode='prompt_fallback'),
        }
        updated = m.with_prompt_fallback(row, selected, {'a': {}, 'b': {}})
        self.assertEqual([(a['question_id'], a['probability']) for a in updated['answers']],
                         [('a', .2), ('b', .7)])
        self.assertEqual(updated['prompt_fallback_n'], 1)
        self.assertEqual(updated['n'], 2)

    def test_xhigh_is_separate_web_filter_row(self):
        answer = dict(question_id='a', probability=.7, outcome=1, mode='xhigh',
                      raw_model='codex:gpt-6-astra', condition_id='xhigh')
        selected = {('xhigh', 'web-filter', 'a'): answer}
        xhigh = m.xhigh_row(selected, {}, {'a': {}})
        combined = m.combine([], [xhigh], ['b'], ['a'])
        row = next(r for r in combined if r['model'] == m.ASTRA_XHIGH)
        self.assertEqual(row['arm'], 'web-filter')
        self.assertEqual(row['n'], 1)
        self.assertEqual(row['effort'], 'xhigh')
        self.assertEqual(len([r for r in combined if r['model'] == m.ASTRA_XHIGH]), 1)

    def test_alternate_run_requires_pinned_grading_and_effort(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            qpath, gpath = folder / 'questions.jsonl', folder / 'grading.jsonl'
            question = {'id': 'a', 'prompt': 'Make a forecast.'}
            grade = {'id': 'a', 'resolution_result': 1}
            qpath.write_text(json.dumps(question) + '\n')
            gpath.write_text(json.dumps(grade) + '\n')
            qhash = hashlib.sha256(qpath.read_bytes()).hexdigest()
            ghash = hashlib.sha256(gpath.read_bytes()).hexdigest()
            pool = 'question-pool:questions@' + hashlib.sha256(
                qpath.read_bytes() + b'\nGRADING\n' + gpath.read_bytes()).hexdigest()[:12]
            run = {'run_id': 'r1', 'started_at_utc': '2026-09-23T00:00:00Z',
                   'config': {'question_set': {'file_sha256': qhash, 'grading_file_sha256': ghash},
                              'question_set_id': pool, 'llm': 'codex:gpt-6-astra',
                              'effort': 'xhigh', 'compare': 'web-filter'}}
            cell = {'run_id': 'r1', 'question_id': 'a', 'arm': 'web-filter', 'status': 'success',
                    'probability': .6, 'condition_id': 'condition'}
            with patch.object(m, 'ALTERNATE_POOLS', (('xhigh', qpath, gpath, qhash, ghash),)):
                selected, _, _ = m.alternate_sources({'a': question}, {'a': grade}, [run], [cell])
                self.assertEqual(selected[('xhigh', 'web-filter', 'a')]['probability'], .6)
                run['config']['effort'] = 'high'
                selected, _, _ = m.alternate_sources({'a': question}, {'a': grade}, [run], [cell])
                self.assertEqual(selected, {})
                run['config']['effort'] = 'xhigh'
                run['config']['execution_mode'] = 'postprocess'
                with self.assertRaisesRegex(ValueError, 'changes execution mode'):
                    m.alternate_sources({'a': question}, {'a': grade}, [run], [cell])
                run['config']['execution_mode'] = None
                gpath.write_text(json.dumps(dict(grade, resolution_result=0)) + '\n')
                with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                    m.alternate_sources({'a': question}, {'a': grade}, [run], [cell])


if __name__ == '__main__':
    unittest.main()
