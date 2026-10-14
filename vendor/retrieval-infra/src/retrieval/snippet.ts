/** Extractive query-biased snippets from the supplied observed text; never synthesize facts. */
export function querySnippet(body: string, query: string, maxChars = 300): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  const stop = new Set('the a an of to in on for and or is are will by with at as be from was has have this that before after'.split(' '));
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(t => t.length >= 2 && !stop.has(t)))];
  const lower = text.toLowerCase();
  const positions: { at: number; term: string }[] = [];
  for (const term of terms) {
    let at = lower.indexOf(term);
    while (at >= 0) {
      positions.push({ at, term });
      at = lower.indexOf(term, at + term.length);
    }
  }
  let bestStart = 0, bestScore = Number.NEGATIVE_INFINITY;
  const candidates = new Set([0, ...positions.flatMap(p => [p.at, Math.max(0, p.at - 60)])]);
  for (const start of candidates) {
    const end = start + maxChars - 2;
    const matching = new Set(positions.filter(p => p.at >= start && p.at + p.term.length <= end).map(p => p.term));
    const span = text.slice(start, end);
    const boilerplate = (span.match(/\b(?:log in|sign up|subscribe|cookie|privacy|all rights reserved|navigation|menu)\b/gi) ?? []).length;
    const score = [...matching].reduce((n,t) => n + Math.min(t.length, 10), 0) - boilerplate * 5;
    if (score > bestScore) { bestScore = score; bestStart = start; }
  }
  return (bestStart ? '…' : '') + text.slice(bestStart, bestStart + maxChars - 2) + '…';
}
