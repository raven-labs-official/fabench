/** Literal query identities; not an entity linker or semantic relevance guarantee. */
export const FROZEN_QUERY_POLICY = 'rarity-literal-identity-guard-v3';

/** Preserve explicit country names and supported source/index phrases when rarity drops them.
 * Do not expand country adjectives: France -> French also admits French fries.
 * US is unsupported because FTS folds it into the pronoun; retain its old behavior.
 * Existing terms remain in the original rarity ladder. No unknown token is deleted.
 */
export function queryIdentity(query: string): { remaining: string; constraints: string[] } {
  const constraints = new Set<string>();
  for (const match of query.matchAll(/\b(?:UK|United Kingdom|Britain|British|China|Chinese|India|Indian|Japan|Japanese|Germany|German|France|French|Canada|Canadian|Australia|Australian|Russia|Russian|Ukraine|Ukrainian|Taiwan|Taiwanese)\b/gi)) {
    constraints.add(`"${match[0].toLowerCase()}"`);
  }
  if (/\bMet\s+Office\b/i.test(query)) constraints.add('"met office"');
  if (/\bS\s*&\s*P\s*500\b/i.test(query)) constraints.add('("s p 500" OR "s p500" OR "sp500")');
  return { remaining: query, constraints: [...constraints] };
}
