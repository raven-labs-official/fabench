/**
 * Paired bootstrap statistics for the leaderboard.
 *
 * Everything is driven by a SEEDED PRNG so the confidence intervals and pairwise
 * probabilities are reproducible — a third party re-running with the same seed and
 * the same per-question forecasts gets bit-identical numbers. (This is the "statistically reproducible"
 * requirement: given the archived per-question forecasts, the leaderboard is deterministic.)
 */

export interface Interval {
  point: number;
  lo: number;
  hi: number;
}

/** ForecastBench display scale: 100 = perfect, 50 = always 0.5, 0 = maximally wrong. */
export function brierIndex(brierScore: number): number {
  if (!Number.isFinite(brierScore) || brierScore < 0 || brierScore > 1) return NaN;
  return (1 - Math.sqrt(brierScore)) * 100;
}

/**
 * Transform an aggregate Brier interval for display. The transform is decreasing, so the
 * Brier upper bound becomes the Brier Index lower bound. Do not transform per-question
 * scores and average them: that would rank mean absolute error instead of mean Brier.
 */
export function brierIndexInterval(interval: Interval): Interval {
  return {
    point: brierIndex(interval.point),
    lo: brierIndex(interval.hi),
    hi: brierIndex(interval.lo),
  };
}

/** Mulberry32 — small, fast, deterministic PRNG. Seeded so CIs are reproducible. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function meanSqErr(forecasts: readonly number[], outcomes: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < forecasts.length; i++) s += (forecasts[i]! - outcomes[i]!) ** 2;
  return s / forecasts.length;
}

function quantile(sorted: readonly number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

const DEFAULT_SEED = 20260723;

/** Bootstrap 95% CI of the Brier score, resampling questions with replacement. */
export function brierCI(
  forecasts: readonly number[],
  outcomes: readonly number[],
  iters = 2000,
  alpha = 0.05,
  seed = DEFAULT_SEED,
): Interval {
  const n = forecasts.length;
  const rng = makeRng(seed);
  const stats: number[] = [];
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rng() * n);
      s += (forecasts[j]! - outcomes[j]!) ** 2;
    }
    stats.push(s / n);
  }
  stats.sort((x, y) => x - y);
  return { point: meanSqErr(forecasts, outcomes), lo: quantile(stats, alpha / 2), hi: quantile(stats, 1 - alpha / 2) };
}

/**
 * Bootstrap 95% CI of the Brier Skill Score BSS = 1 − Brier_agent / Brier_market,
 * over the SAME questions (paired resample: the agent and the market are resampled
 * on the identical bootstrap indices, so the skill comparison is question-matched).
 */
export function bssCI(
  agentForecasts: readonly number[],
  marketForecasts: readonly number[],
  outcomes: readonly number[],
  iters = 2000,
  alpha = 0.05,
  seed = DEFAULT_SEED,
): Interval {
  const n = outcomes.length;
  const rng = makeRng(seed);
  const stats: number[] = [];
  for (let b = 0; b < iters; b++) {
    let sa = 0;
    let sm = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rng() * n);
      sa += (agentForecasts[j]! - outcomes[j]!) ** 2;
      sm += (marketForecasts[j]! - outcomes[j]!) ** 2;
    }
    stats.push(sm === 0 ? 0 : 1 - sa / sm);
  }
  stats.sort((x, y) => x - y);
  const pointMkt = meanSqErr(marketForecasts, outcomes);
  const point = pointMkt === 0 ? 0 : 1 - meanSqErr(agentForecasts, outcomes) / pointMkt;
  return { point, lo: quantile(stats, alpha / 2), hi: quantile(stats, 1 - alpha / 2) };
}

export interface PairResult {
  /** Brier(A) − Brier(B); negative ⇒ A is better. */
  diff: number;
  lo: number;
  hi: number;
  /** Fraction of bootstrap resamples where A has the lower (better) Brier. */
  probAbetter: number;
}

/**
 * Paired comparison of two predictors over the SAME questions: resample question
 * indices once per iteration and score both predictors on them, so the difference
 * is question-matched (removes cross-question variance).
 */
export function pairedBrierDiff(
  aForecasts: readonly number[],
  bForecasts: readonly number[],
  outcomes: readonly number[],
  iters = 2000,
  alpha = 0.05,
  seed = DEFAULT_SEED,
): PairResult {
  const n = outcomes.length;
  const rng = makeRng(seed);
  const diffs: number[] = [];
  let wins = 0;
  for (let b = 0; b < iters; b++) {
    let sa = 0;
    let sb = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rng() * n);
      sa += (aForecasts[j]! - outcomes[j]!) ** 2;
      sb += (bForecasts[j]! - outcomes[j]!) ** 2;
    }
    const d = (sa - sb) / n;
    diffs.push(d);
    if (d < 0) wins++;
  }
  diffs.sort((x, y) => x - y);
  return {
    diff: meanSqErr(aForecasts, outcomes) - meanSqErr(bForecasts, outcomes),
    lo: quantile(diffs, alpha / 2),
    hi: quantile(diffs, 1 - alpha / 2),
    probAbetter: wins / iters,
  };
}
