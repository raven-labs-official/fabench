"""The Python Brier helpers reproduce the fixed values of the TypeScript scoring tests."""
import math
import unittest

from reporting.scoring import brier_index, brier_score


class BrierScoringTests(unittest.TestCase):
    def test_brier_index_matches_bootstrap_test_values(self):
        # src/scoring/bootstrap.test.ts
        self.assertEqual(brier_index(0), 100)
        self.assertEqual(brier_index(0.25), 50)
        self.assertEqual(brier_index(1), 0)
        self.assertLess(abs(brier_index(0.086) - 70.674243), 1e-6)
        # brierIndexInterval maps the Brier bounds 0.16 and 0.36 to Index 60 and 40.
        self.assertEqual((brier_index(0.16), brier_index(0.36)), (60, 40))

    def test_brier_index_rejects_scores_outside_the_scale(self):
        for value in (-0.01, 1.01, math.inf, math.nan):
            with self.subTest(value=value):
                self.assertTrue(math.isnan(brier_index(value)))

    def test_brier_score_matches_forecast_report_values(self):
        # src/experiments/forecast.test.ts: outcomes [1, 0, 1], each arm missing one forecast.
        self.assertLess(abs(brier_score([(0.2, 1), (0.7, 1)]) - 0.365), 1e-12)
        self.assertLess(abs(brier_score([(0.8, 1), (0.4, 0)]) - 0.1), 1e-12)
        # src/analysis/leaderboard-cli.test.ts: example B forecasts 0.5 on outcomes 1, 0, 1, 0.
        constant = brier_score([(0.5, 1), (0.5, 0), (0.5, 1), (0.5, 0)])
        self.assertEqual((constant, brier_index(constant)), (0.25, 50))


if __name__ == '__main__':
    unittest.main()
