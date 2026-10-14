/** Canonical names stored in manifests and result rows. */
export type HarnessId = "claude-code" | "codex" | "raven" | null;
export type SearchType =
  | "none"
  | "frozen"
  | "web-filter"
  | "backsearch"
  | "both"
  | string;

export interface ToolBudgetIdentity {
  /** Shared cap across web_search and web_fetch, not a search-only counter. */
  max_tool_calls: number;
  /** A search can consume the whole shared budget, so this is an upper bound, not a second cap. */
  max_search_calls: number;
  /** A fetch can likewise consume the whole shared budget. */
  max_fetch_calls: number;
  max_results_per_search: number | null;
  budget_scope: "shared-across-search-and-fetch" | "no-tools";
}

/** Stable, explicit description of the evidence budget that contributes to condition_id. */
export function toolBudgetIdentity(
  retrievalEnabled: boolean,
  maxToolCalls: number,
  maxResultsPerSearch: number,
): ToolBudgetIdentity {
  if (!retrievalEnabled) {
    return {
      max_tool_calls: 0,
      max_search_calls: 0,
      max_fetch_calls: 0,
      max_results_per_search: null,
      budget_scope: "no-tools",
    };
  }
  return {
    max_tool_calls: maxToolCalls,
    max_search_calls: maxToolCalls,
    max_fetch_calls: maxToolCalls,
    max_results_per_search: maxResultsPerSearch,
    budget_scope: "shared-across-search-and-fetch",
  };
}

/**
 * `web` was the historical CLI label. The arm has always included temporal filtering, so new
 * runs emit `web-filter`; the old spelling remains an input alias for saved shell commands.
 */
export function canonicalArmSpec(raw: string): {
  canonical: string;
  usedLegacyWebAlias: boolean;
} {
  let usedLegacyWebAlias = false;
  const canonical = raw
    .trim()
    .split("+")
    .map((part) => {
      if (part.trim() === 'mixed') return 'both';
      if (part.trim() !== "web") return part.trim();
      usedLegacyWebAlias = true;
      return "web-filter";
    })
    .join("+");
  assertSupportedArmComposition(canonical);
  return { canonical, usedLegacyWebAlias };
}

/** Admission must validate both resources of a mixed arm. */
export function armUsesWebFilter(compare = ''): boolean {
  return compare.split(',').some(arm => ['mixed','both'].includes(arm) || arm.split('+').includes('web-filter'));
}
export function armUsesFrozen(compare = ''): boolean {
  return compare.split(',').some(arm => ['mixed','both'].includes(arm) || arm.split('+').includes('frozen'));
}

/** The retired n+n frozen/web merge has no runnable spelling. */
export function assertSupportedArmComposition(spec: string): void {
  const parts = spec.split('+').map(part => part.trim() === 'web' ? 'web-filter' : part.trim());
  if (parts.includes('frozen') && parts.includes('web-filter'))
    throw new Error('The legacy frozen+web-filter merge was removed; use both for the fixed half-prefix method');
  if (parts.some(part => part === 'both' || part === 'mixed') && parts.length !== 1)
    throw new Error('both is a fixed half-prefix method and cannot be combined or expanded');
}
