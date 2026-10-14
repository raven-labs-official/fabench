import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('trajectory', Path(__file__).with_name('trajectory-fidelity.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def row(q='Q1', facts=None):
    out = dict(question_id=q, as_of='2026-03-01T00:00:00Z', prompt_facts=['baseline'])
    if facts is not None:
        out['retrieved_facts'] = facts
    return out


class TrajectoryFidelityTest(unittest.TestCase):
    def test_prompt_information_does_not_inflate_retrieval_increment(self):
        result = module.compare([row(facts=['baseline', 'trend'])], [row(facts=['baseline'])])['pairs'][0]
        self.assertEqual(result['retrieval_fact_recall'], 0.5)
        self.assertEqual(result['incremental_fact_recall'], 0)
        self.assertEqual(result['total_available_fact_recall'], 0.5)

    def test_different_query_sequences_and_repeated_facts(self):
        ref = row(facts=['trend', 'schedule'])
        ref['queries'] = ['one query']
        got = row(facts=['schedule', 'trend', 'trend', 'extra'])
        got['queries'] = ['different query', 'follow up']
        result = module.compare([ref], [got])['pairs'][0]
        self.assertEqual(result['retrieval_fact_recall'], 1)
        self.assertEqual(result['retrieval_membership_precision'], 2/3)
        self.assertEqual(result['additional_candidate_retrieved_ids'], ['extra'])

    def test_missing_trace_is_a_miss_but_prompt_is_still_available(self):
        result = module.compare([row(facts=['trend'])], [])
        self.assertEqual(result['missing_candidates'], 1)
        self.assertEqual(result['macro']['retrieval_fact_recall']['mean'], 0)
        self.assertEqual(result['pairs'][0]['total_available_fact_recall'], 0.5)

    def test_unannotated_and_audited_empty_are_distinct(self):
        unavailable = module.compare([row(facts=['trend'])], [row()])
        self.assertEqual(unavailable['unannotated_questions'], 1)
        self.assertIsNone(unavailable['macro']['retrieval_fact_recall']['mean'])
        empty = module.compare([row(facts=[])], [row(facts=[])])
        self.assertEqual(empty['completely_annotated_questions'], 1)
        self.assertIsNone(empty['micro']['retrieval_fact_recall'])
        self.assertEqual(empty['micro']['total_available_fact_recall'], 1)

    def test_question_macro_and_micro_have_different_denominators(self):
        refs = [row('Q1', ['a']), row('Q2', ['b', 'c', 'd'])]
        got = [row('Q1', ['a']), row('Q2', [])]
        result = module.compare(refs, got)
        self.assertEqual(result['macro']['retrieval_fact_recall']['mean'], 0.5)
        self.assertEqual(result['micro']['retrieval_fact_recall'], 0.25)

    def test_identity_errors_are_rejected(self):
        ref = row(facts=['trend'])
        bad_prompt = dict(ref, prompt_facts=['other'])
        bad_anchor = dict(ref, as_of='2026-03-02T00:00:00Z')
        with self.assertRaises(ValueError): module.compare([ref, ref], [])
        with self.assertRaises(ValueError): module.compare([ref], [bad_prompt])
        with self.assertRaises(ValueError): module.compare([ref], [bad_anchor])
        with self.assertRaises(ValueError): module.compare([ref], [row('Q2', [])])
        with self.assertRaises(ValueError): module.compare([dict(ref, as_of='2026-03-01')], [])
        with self.assertRaises(ValueError): module.compare([dict(ref, retrieved_facts='trend')], [])


if __name__ == '__main__':
    unittest.main()
