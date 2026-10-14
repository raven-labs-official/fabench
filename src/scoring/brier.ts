export function expectedCalibrationError(
  forecasts: readonly number[],
  outcomes: readonly (0 | 1)[],
  bins = 10,
): number {
  if (forecasts.length === 0) return 0;
  const binCounts = new Array(bins).fill(0) as number[];
  const binSumForecast = new Array(bins).fill(0) as number[];
  const binSumOutcome = new Array(bins).fill(0) as number[];

  for (let i = 0; i < forecasts.length; i++) {
    const binIdx = Math.min(Math.floor(forecasts[i]! * bins), bins - 1);
    binCounts[binIdx]!++;
    binSumForecast[binIdx]! += forecasts[i]!;
    binSumOutcome[binIdx]! += outcomes[i]!;
  }

  let ece = 0;
  for (let b = 0; b < bins; b++) {
    if (binCounts[b]! === 0) continue;
    const avgForecast = binSumForecast[b]! / binCounts[b]!;
    const avgOutcome = binSumOutcome[b]! / binCounts[b]!;
    ece += (binCounts[b]! / forecasts.length) * Math.abs(avgForecast - avgOutcome);
  }
  return ece;
}

export function logLoss(
  forecasts: readonly number[],
  outcomes: readonly (0 | 1)[],
  eps = 1e-15,
): number {
  if (forecasts.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < forecasts.length; i++) {
    const p = Math.max(eps, Math.min(1 - eps, forecasts[i]!));
    const o = outcomes[i]!;
    sum += -(o * Math.log(p) + (1 - o) * Math.log(1 - p));
  }
  return sum / forecasts.length;
}
