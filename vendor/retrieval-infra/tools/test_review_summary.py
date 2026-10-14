import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('summary', Path(__file__).with_name('summarize-retrieval-reviews.py'))
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


class GateDenominators(unittest.TestCase):
    def test_visible_only_sample_does_not_claim_perfect_clean_retention(self):
        module = SimpleNamespace(weighted_leakage_metrics=lambda rows: {
            'point': {'leakage_lower_bound': .2, 'clean_delivery_retention': 1.0},
            'approximate_question_cluster_bootstrap': {'clean_delivery_retention': {'percentile95': [1, 1]}}})
        got = summary.visible_only_metrics(module, [])
        self.assertEqual(got['point']['leakage_lower_bound'], .2)
        self.assertNotIn('clean_delivery_retention', got['point'])
        self.assertNotIn('clean_delivery_retention', got['approximate_question_cluster_bootstrap'])
        self.assertFalse(got['clean_retention']['identifiable'])

    def test_irrelevant_unknown_still_counts_toward_possible_leakage(self):
        rows = [
            {'weight': 9, 'accepted': True, 'adjudication': {'label': 'unknown', 'usable': False}},
            {'weight': 1, 'accepted': True, 'adjudication': {'label': 'clean', 'usable': True}},
        ]
        got = summary.gate_metrics(rows, 'accepted')
        self.assertEqual(got['candidate_body_leakage_upper_bound'], .9)
        self.assertEqual(got['clean_gate_retention_among_adjudicated'], 1)

    def test_errors_are_neither_successful_blocks_nor_passes(self):
        rows = [
            {'weight': 3, 'accepted': None, 'adjudication': {'label': 'leaked'}},
            {'weight': 1, 'accepted': False, 'adjudication': {'label': 'leaked'}},
        ]
        got = summary.gate_metrics(rows, 'accepted')
        self.assertEqual(got['sample_decision_errors'], 1)
        self.assertEqual(got['sample_accepted_candidates'], 0)
        self.assertEqual(got['leak_gate_block_recall_among_adjudicated'], .25)
        self.assertIsNone(got['candidate_body_leakage_lower_bound'])

    def test_unresolved_review_error_can_be_a_clean_delivery_loss(self):
        rows = [
            {'weight': 3, 'accepted': None, 'adjudication': {'label': 'unknown'}},
            {'weight': 1, 'accepted': True, 'adjudication': {'label': 'clean'}},
        ]
        got = summary.gate_metrics(rows, 'accepted')
        self.assertEqual(got['clean_gate_retention_lower_bound'], .25)
        self.assertEqual(got['clean_gate_retention_upper_bound'], 1)
        self.assertEqual(got['sample_decision_errors'], 1)


if __name__ == '__main__':
    unittest.main()
