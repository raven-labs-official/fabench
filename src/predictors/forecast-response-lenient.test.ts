import assert from "node:assert/strict";
import test from "node:test";
import { parseForecastAnswer, parseForecastResponse, withoutTrailingCommas } from "./forecast-response.js";

const numeric = { probability_yes: 0.45, numeric_forecast: { value: 4.87, unit: "percent" }, rationale: "Yields drift lower." };
const event = { probability_yes: 0.88, numeric_forecast: null, rationale: "Approval is expected on time." };

test("a strictly valid answer is returned unchanged with no repairs", () => {
  assert.deepEqual(parseForecastAnswer(JSON.stringify(numeric), "percent"), { answer: numeric, format_repairs: [] });
});

test("extra fields are ignored and named, and values are never changed", () => {
  const raw = JSON.stringify({ ...numeric, rationale_note: "Forecast made before the cutoff." });
  assert.throws(() => parseForecastResponse(raw, "percent"));
  const parsed = parseForecastAnswer(raw, "percent");
  assert.deepEqual(parsed.answer, numeric);
  assert.deepEqual(parsed.format_repairs, ["extra_field:rationale_note"]);
  const eventRaw = JSON.stringify({ ...event, sources: [] });
  assert.deepEqual(parseForecastAnswer(eventRaw, null), { answer: event, format_repairs: ["extra_field:sources"] });
  const inner = JSON.stringify({ ...numeric, numeric_forecast: { ...numeric.numeric_forecast, note: "median" } });
  assert.deepEqual(parseForecastAnswer(inner, "percent").format_repairs, ["extra_numeric_field:note"]);
});

test("a self-corrected reply with two identical answers and prose between them is read once", () => {
  const raw = JSON.stringify({ ...numeric, rationale_note: "x" }) + "\n\nWait — I must return exactly three keys.\n\n" + JSON.stringify(numeric);
  assert.deepEqual(parseForecastAnswer(raw, "percent"), {
    answer: numeric, format_repairs: ["extra_field:rationale_note", "repeated_answer:2", "text_outside_answer"],
  });
  const fenced = "Here is the forecast:\n```json\n" + JSON.stringify(event) + "\n```";
  assert.deepEqual(parseForecastAnswer(fenced, null).format_repairs, ["text_outside_answer"]);
});

test("broken JSON, conflicting answers, missing fields and other units still fail", () => {
  const broken = '{"probability_yes":0.85,"numeric_forecast":null,"rationale":"Mari leads.","}"}';
  assert.throws(() => parseForecastAnswer(broken, null));
  assert.throws(() => parseForecastAnswer(JSON.stringify(numeric) + JSON.stringify({ ...numeric, probability_yes: 0.5 }), "percent"), /conflicting/);
  const { rationale, ...noRationale } = numeric;
  assert.throws(() => parseForecastAnswer(JSON.stringify({ ...noRationale, rationale_short: rationale }), "percent"));
  assert.throws(() => parseForecastAnswer(JSON.stringify({ ...numeric, numeric_forecast: { value: 4.87, unit: "%" }, note: "x" }), "percent"));
  assert.throws(() => parseForecastAnswer(JSON.stringify({ ...event, numeric_forecast: { value: 1, unit: "count" }, note: "x" }), null));
  assert.throws(() => parseForecastAnswer(JSON.stringify({ ...numeric, probability_yes: 1.2, note: "x" }), "percent"));
  assert.throws(() => parseForecastAnswer("Probably about 0.4.", null), /not one JSON object/);
});

test("a comma left before the closing brace is read and reported, values unchanged", () => {
  // Shapes seen on 2026-09-17 (J-TEC-27, J-WEA-10): the rationale string, a comma, a newline, then `}`.
  const raw = JSON.stringify(numeric).slice(0, -1) + ",\n}";
  assert.throws(() => parseForecastResponse(raw, "percent"));
  assert.deepEqual(parseForecastAnswer(raw, "percent"), { answer: numeric, format_repairs: ["trailing_comma"] });
  const inner = '{"probability_yes":0.45,"numeric_forecast":{"value":4.87,"unit":"percent",},"rationale":"Yields drift lower.", }';
  assert.deepEqual(parseForecastAnswer(inner, "percent"), { answer: numeric, format_repairs: ["trailing_comma"] });
  const withExtra = JSON.stringify({ ...event, note: "x" }).slice(0, -1) + ",}";
  assert.deepEqual(parseForecastAnswer(withExtra, null).format_repairs, ["extra_field:note", "trailing_comma"]);
});

test("commas inside strings are kept and other broken endings still fail", () => {
  assert.equal(withoutTrailingCommas('{"rationale":"a, }"}'), null);
  assert.equal(withoutTrailingCommas('{"rationale":"say \\",}"}'), null);
  assert.equal(withoutTrailingCommas('{"a":[1,2,],}'), '{"a":[1,2]}');
  const quoted = '{"probability_yes":0.3,"numeric_forecast":null,"rationale":"x."," }';
  assert.throws(() => parseForecastAnswer(quoted, null));
  const missing = '{"probability_yes":0.3,"numeric_forecast":null,}';
  assert.throws(() => parseForecastAnswer(missing, null));
});

test("the comma repair never changes a reply the earlier policy could read", () => {
  const conflicting = JSON.stringify(event) + "\n" + JSON.stringify({ ...event, probability_yes: 0.1 }).slice(0, -1) + ",}";
  assert.deepEqual(parseForecastAnswer(conflicting, null), { answer: event, format_repairs: ["text_outside_answer"] });
});
