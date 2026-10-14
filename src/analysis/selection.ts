/** Select settled questions with the same label in every input, preserving input order. */
export function commonLabels<T extends { outcome: number | null }>(
  runs: readonly ReadonlyMap<string, T>[],
  ids: Iterable<string> = runs[0]?.keys() ?? [],
): { commonIds: string[]; conflicting: number } {
  let conflicting = 0;
  const commonIds = [...ids].filter((id) => {
    const label = runs[0]?.get(id)?.outcome;
    if (label == null) return false;
    return runs.every((run) => {
      const row = run.get(id);
      if (!row || row.outcome == null) return false;
      if (row.outcome !== label) {
        conflicting++;
        return false;
      }
      return true;
    });
  });
  return { commonIds, conflicting };
}
