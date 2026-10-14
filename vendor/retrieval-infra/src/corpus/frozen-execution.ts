import { availableParallelism } from 'node:os';

/** A bounded per-run default, not a reservation of shared host capacity. */
export function defaultFrozenWorkers(parallelism = availableParallelism()): number {
  if (!Number.isSafeInteger(parallelism) || parallelism < 1) throw new Error('Invalid CPU parallelism');
  return Math.min(4, parallelism);
}
