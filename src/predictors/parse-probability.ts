/**
 * Extract the final probability from an LLM forecast.
 *
 * Forecasting LLMs reason first and emit intermediate numbers (base rate, an
 * "initial probability", etc.), then a FINAL answer. So we always take the LAST
 * match, and prefer the explicit delimiter the prompt asks for: `*0.NN*`
 * (the ForecastBench/Halawi convention). Fallbacks cover "Probability: NN%",
 * bare decimals, and bare percentages.
 *
 * Returns a value clamped to [CLAMP_MIN, CLAMP_MAX] — proper scoring rules punish
 * 0/1 extremes brutally, and a single wrong 1.0 is catastrophic — or null if no
 * number could be found (caller decides the fallback).
 */
export const CLAMP_MIN = 0.01;
export const CLAMP_MAX = 0.99;

function clamp(p: number): number {
  return Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, p));
}

/** Last match of a global regex, or null. Group 1 must hold the number. */
function lastMatch(text: string, re: RegExp): number | null {
  let m: RegExpExecArray | null;
  let last: number | null = null;
  while ((m = re.exec(text)) !== null) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) last = v;
  }
  return last;
}

export function parseProbability(text: string): number | null {
  if (!text) return null;

  // 1. Preferred: asterisk-delimited decimal in [0,1], e.g. *0.62* or *0*.
  const asterisk = lastMatch(text, /\*\s*(0(?:\.\d+)?|1(?:\.0+)?|\.\d+)\s*\*/g);
  if (asterisk !== null) return clamp(asterisk);

  // 2. "Probability: NN%" (also "probability is 62%", "final probability 62 %").
  const pctLabeled = lastMatch(text, /probability[^0-9%]{0,20}(\d{1,3}(?:\.\d+)?)\s*%/gi);
  if (pctLabeled !== null) return clamp(pctLabeled / 100);

  // 3. "Probability: 0.62" (labeled decimal).
  const decLabeled = lastMatch(text, /probability[^0-9]{0,20}(0(?:\.\d+)?|1(?:\.0+)?|\.\d+)\b/gi);
  if (decLabeled !== null) return clamp(decLabeled);

  // 4. Any bare percentage, last one.
  const pct = lastMatch(text, /(\d{1,3}(?:\.\d+)?)\s*%/g);
  if (pct !== null) return clamp(pct / 100);

  // 5. Any bare decimal in [0,1], last one.
  const dec = lastMatch(text, /\b(0\.\d+|1\.0+|0|1)\b/g);
  if (dec !== null) return clamp(dec);

  return null;
}
