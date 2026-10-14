/** Opt-in response contract. Malformed answers fail; they never silently become 0.5 or zero. */
export interface ForecastResponse {
  probability_yes: number;
  numeric_forecast: { value: number; unit: string } | null;
  rationale: string;
}

/**
 * Runtime reading of the v2.1 answer. The three required fields keep their exact rules, and
 * no value is changed. Three presentation slips are tolerated and reported: extra fields next
 * to the required ones, text or repeated identical objects around the answer, and a comma
 * left before a closing brace or bracket. Several answers that disagree, other broken JSON
 * (including a comma followed by an unfinished key), a missing field or a different unit
 * still fail. Every reply the previous policy accepted is read identically.
 */
export const FORECAST_PARSE_POLICY = "raven.forecast.v2.1-ignore-extra-fields-trailing-comma-v1";
/** Earlier runtime policies whose accepted replies this policy reads identically. */
export const FORECAST_PARSE_POLICY_PREDECESSORS = Object.freeze(["raven.forecast.v2.1-ignore-extra-fields-v1"]);

export interface ParsedForecast {
  answer: ForecastResponse;
  /** Empty for a strictly valid reply; otherwise what was ignored, e.g. `extra_field:rationale_note`. */
  format_repairs: string[];
}

const TOP_KEYS = ["numeric_forecast", "probability_yes", "rationale"];
const isObject = (o: unknown): o is Record<string, unknown> =>
  !!o && typeof o === "object" && !Array.isArray(o);
const sameKeys = (o: unknown, keys: string[]) =>
  isObject(o) && Object.keys(o).sort().join(",") === [...keys].sort().join(",");

export function parseForecastResponse(text: string, unit: string | null): ForecastResponse {
  let x: any;
  try { x = JSON.parse(text); } catch { throw new Error("Forecast response is not one JSON object"); }
  if (!sameKeys(x, TOP_KEYS)) throw new Error("Invalid forecast response keys/probability/rationale");
  return checkedFields(x, unit);
}

function checkedFields(x: any, unit: string | null): ForecastResponse {
  if (typeof x.probability_yes !== "number" || !Number.isFinite(x.probability_yes) ||
      x.probability_yes < 0 || x.probability_yes > 1 || typeof x.rationale !== "string" || !x.rationale.trim())
    throw new Error("Invalid forecast response keys/probability/rationale");
  if (unit === null) {
    if (x.numeric_forecast !== null) throw new Error("Event-only forecast must have numeric_forecast=null");
  } else if (!sameKeys(x.numeric_forecast, ["value", "unit"]) ||
      typeof x.numeric_forecast.value !== "number" || !Number.isFinite(x.numeric_forecast.value) ||
      x.numeric_forecast.unit !== unit) {
    throw new Error("Numeric forecast requires a finite value and the exact question unit");
  }
  return { probability_yes: x.probability_yes, numeric_forecast: x.numeric_forecast, rationale: x.rationale };
}

/** Drop commas that stand directly before `}` or `]`, outside strings; null when there are none. */
export function withoutTrailingCommas(text: string): string | null {
  let out = "", inString = false, escaped = false, changed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") { changed = true; continue; }
    }
    out += c;
  }
  return changed ? out : null;
}

/**
 * Top-level JSON objects in order, with the character spans they occupy. The comma repair is
 * used only as a second pass, so a reply the previous policy could read is read the same way.
 */
function jsonObjects(text: string, repairCommas = false): { value: unknown; start: number; end: number; trailingComma: boolean }[] {
  const found: { value: unknown; start: number; end: number; trailingComma: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { end = j + 1; break; }
    }
    if (end < 0) continue;
    const slice = text.slice(i, end);
    try { found.push({ value: JSON.parse(slice), start: i, end, trailingComma: false }); i = end - 1; continue; } catch { /* maybe the comma slip */ }
    const repaired = repairCommas ? withoutTrailingCommas(slice) : null;
    if (repaired === null) continue;
    try { found.push({ value: JSON.parse(repaired), start: i, end, trailingComma: true }); i = end - 1; } catch { /* not an object */ }
  }
  return found;
}

export function parseForecastAnswer(text: string, unit: string | null): ParsedForecast {
  let strictError: unknown;
  try { return { answer: parseForecastResponse(text, unit), format_repairs: [] }; }
  catch (error) { strictError = error; }
  const forecasts = (repairCommas: boolean) => jsonObjects(text, repairCommas)
    .filter(o => isObject(o.value) && Object.hasOwn(o.value as object, "probability_yes"));
  let candidates = forecasts(false);
  if (!candidates.length) candidates = forecasts(true);
  if (!candidates.length) throw strictError;
  const repairs = new Set<string>();
  if (candidates.some(c => c.trailingComma)) repairs.add("trailing_comma");
  const answers = candidates.map(({ value }) => {
    const o = value as Record<string, any>;
    for (const key of Object.keys(o)) if (!TOP_KEYS.includes(key)) repairs.add(`extra_field:${key}`);
    if (isObject(o.numeric_forecast))
      for (const key of Object.keys(o.numeric_forecast)) if (!["value", "unit"].includes(key)) repairs.add(`extra_numeric_field:${key}`);
    const numeric = isObject(o.numeric_forecast)
      ? { value: o.numeric_forecast.value, unit: o.numeric_forecast.unit } : o.numeric_forecast;
    return checkedFields({ probability_yes: o.probability_yes, numeric_forecast: numeric, rationale: o.rationale }, unit);
  });
  const key = (a: ForecastResponse) => JSON.stringify([a.probability_yes, a.numeric_forecast]);
  if (answers.some(a => key(a) !== key(answers[0]!)))
    throw new Error("Forecast response contains conflicting answers");
  if (answers.length > 1) repairs.add(`repeated_answer:${answers.length}`);
  let outside = text;
  for (const c of [...candidates].reverse()) outside = outside.slice(0, c.start) + outside.slice(c.end);
  if (outside.trim()) repairs.add("text_outside_answer");
  return { answer: answers[0]!, format_repairs: [...repairs].sort() };
}
