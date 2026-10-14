"""Brier score and Brier Index; the Python counterpart of src/scoring/bootstrap.ts."""
import math


def brier_score(pairs):
    """Mean squared error of nonempty (probability, outcome) pairs the caller has validated.

    math.fsum keeps the values these reports have always published; the TypeScript running
    sum can differ from it in the last bits.
    """
    pairs = list(pairs)
    return math.fsum((p - y) ** 2 for p, y in pairs) / len(pairs)


def brier_index(brier):
    """ForecastBench display scale: 100 = perfect, 50 = always 0.5, 0 = maximally wrong."""
    if not math.isfinite(brier) or not 0 <= brier <= 1:
        return math.nan
    return 100 * (1 - math.sqrt(brier))
