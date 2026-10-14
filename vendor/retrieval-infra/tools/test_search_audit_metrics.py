import itertools
import unittest
from search_audit_metrics import coverage, leakage_bounds, corrected_leakage


class MetricsTests(unittest.TestCase):
    def test_partial_article_preserves_direction_not_numeric_range(self):
        refs = [{"id": "guidance", "facets": [{"id": "raised", "weight": 0.4}, {"id": "range", "weight": 0.6}]}]
        match = {"reference_id": "guidance", "identity_verified": True, "facets": {
            "raised": {"label": "supported", "evidence": [{"source_id": "doc", "quote": "raised guidance"}]}}}
        x = coverage(refs, [match, match], {"doc": "The company raised guidance."})
        self.assertAlmostEqual(x["partial_coverage"], 0.4)
        self.assertEqual(x["complete_recall"], 0)
        match["identity_verified"] = False
        self.assertEqual(coverage(refs, [match], {"doc": "raised guidance"})["partial_coverage"], 0)

    def test_false_quote_and_duplicate_references_are_rejected(self):
        refs = [{"id": "a", "facets": [{"id": "v"}]}]
        with self.assertRaises(ValueError):
            coverage(refs, [{"reference_id": "a", "identity_verified": True, "facets": {
                "v": {"label": "supported", "evidence": [{"source_id": "d", "quote": "invented"}]}}}], {"d": "actual text"})
        with self.assertRaises(ValueError):
            coverage(refs * 2, [], {})

    def test_empty_reference_is_unmeasurable(self):
        self.assertIsNone(coverage([], [], {})["complete_recall"])

    def test_exposure_and_event_denominators_differ(self):
        x = leakage_bounds([
            {"id": "a", "event_id": "e1", "label": "leak", "multiplicity": 7},
            {"id": "b", "event_id": "e1", "label": "unknown", "multiplicity": 13},
            {"id": "c", "event_id": "e2", "label": "safe", "multiplicity": 80}])
        self.assertEqual(x["leakage_lower"], 0.07)
        self.assertEqual(x["leakage_upper"], 0.2)
        self.assertEqual(x["event_leakage_lower"], 0.5)
        self.assertEqual(x["event_leakage_upper"], 0.5)

    def test_census_recovers_truth_even_with_wrong_model(self):
        pop = [{"id": "a", "model_score": 0.95, "exposure_weight": 3}, {"id": "b", "model_score": 0.2}]
        audit = [{"id": "a", "label": 0, "inclusion_probability": 1}, {"id": "b", "label": 1, "inclusion_probability": 1}]
        self.assertAlmostEqual(corrected_leakage(pop, audit)["corrected_rate_unclipped"], 0.25)

    def test_probability_sampling_correction_is_unbiased_over_all_samples(self):
        pop = [{"id": str(i), "model_score": p, "exposure_weight": w} for i, (p, w) in enumerate([(0.8, 3), (0.2, 1), (0.9, 2), (0.1, 1)])]
        truth = [0, 1, 1, 0]
        estimates = []
        for sample in itertools.combinations(range(4), 2):
            audit = [{"id": str(i), "label": truth[i], "inclusion_probability": 0.5} for i in sample]
            estimates.append(corrected_leakage(pop, audit)["corrected_rate_unclipped"])
        self.assertAlmostEqual(sum(estimates) / len(estimates), 3 / 7)

    def test_unknown_gold_and_zero_inclusion_are_rejected(self):
        for label, pi in [(None, 1), (1, 0)]:
            with self.assertRaises(ValueError):
                corrected_leakage([{"id": "a", "model_score": 0.5}], [{"id": "a", "label": label, "inclusion_probability": pi}])


if __name__ == "__main__":
    unittest.main()
