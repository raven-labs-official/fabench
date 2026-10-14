import unittest
from reporting.selection import ordered_runs, paper_answers, select_answers_by_priority


class SelectionTests(unittest.TestCase):
    def test_priority_is_strict_then_earliest_not_highest_probability(self):
        runs = [dict(run_id='review', started_at_utc='2020', config={'execution_mode': 'postprocess'}),
                dict(run_id='b', started_at_utc='2022', config={}),
                dict(run_id='a', started_at_utc='2022', config={})]
        self.assertEqual([r['run_id'] for r in ordered_runs(runs)], ['a', 'b', 'review'])
        strict = dict(question_id='a', probability=.2, outcome=1, condition_id='strict', source_run_id='old')
        review = dict(question_id='a', probability=.9, outcome=1, condition_id='reviewed')
        missing = dict(question_id='b', probability=.7, outcome=0, condition_id='reviewed')
        self.assertEqual(select_answers_by_priority([[strict], [review, missing]]), {'a': strict, 'b': missing})

    def test_native_source_wins_and_router_only_fills_missing_ids(self):
        native = dict(question_id='a', probability=.2, outcome=1, source_run_id='native')
        fallback = dict(question_id='b', probability=.8, outcome=0, source_run_id='router')
        rows = {('Kimi K3', 'both'): {'answers': [native]},
                ('openrouter:moonshotai/kimi-k3', 'both'): {'answers': [dict(native, probability=.9), fallback]}}
        self.assertEqual(paper_answers(rows, 'Kimi K3', 'both', {'a', 'b'}, {'a': 1, 'b': 0}),
                         {'a': native, 'b': fallback})
        with self.assertRaisesRegex(ValueError, 'Grading mismatch'):
            paper_answers(rows, 'Kimi K3', 'both', {'a'}, {'a': 0})

    def test_null_preferred_answer_and_out_of_scope_ids_stay_excluded(self):
        primary = [{'question_id': 'a', 'probability': None}, {'question_id': 'outside', 'probability': .9}]
        fallback = [{'question_id': 'a', 'probability': .5}, {'question_id': 'b', 'probability': .7}]
        self.assertEqual(select_answers_by_priority([primary, fallback], {'a', 'b'}), {'b': fallback[1]})
