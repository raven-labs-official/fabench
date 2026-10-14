import assert from "node:assert/strict";
import test from "node:test";

import { computeProbability, parseLedger } from "./evidence-ledger.js";

/**
 * The POINTS table is a SHADOW: it never sets a forecast, it only says what it would have set,
 * so that a table can be fitted on one set of questions and tested on another. These tests pin
 * its arithmetic and the parsing of the ledger the model actually emits.
 */

const L = (o: Partial<Parameters<typeof computeProbability>[0]>) => ({
  question_shape: null,
  window_days: null,
  base_rate: 0.5,
  base_rate_source: "x",
  entries: [],
  final_probability: null,
  ...o,
});

test("a narrative cannot move a forecast far however many items it has", () => {
  // The measured shape of the worst hurt cells: a pile of individually-plausible escalation
  // stories all pointing the same way, taking a 0.05 prior to a confident wrong yes.
  const c = computeProbability(L({
    base_rate: 0.05,
    base_rate_source: "low-base-rate dramatic event",
    entries: Array.from({ length: 6 }, (_, i) => ({
      claim: `escalation story ${i}`,
      evidence_type: "narrative" as const,
      direction: "+" as const,
    })),
  }));
  assert.equal(c.totalPoints, 10, "six narrative items must cap at the type's net ceiling");
  assert.ok(c.cappedTypes.includes("narrative"));
  assert.equal(c.probability, 0.15);
});

test("a fact that already settled the question is not capped", () => {
  // The mirror case: 69% of the large HELPFUL moves surfaced an already-settled fact, so
  // capping by size rather than by type would cost as much as it saved.
  const c = computeProbability(L({
    base_rate: 0.3,
    base_rate_source: "historical frequency",
    entries: [
      { claim: "it happened in November", evidence_type: "already_happened", direction: "+" },
      { claim: "and again in December", evidence_type: "already_happened", direction: "+" },
    ],
  }));
  assert.equal(c.totalPoints, 40);
  assert.equal(c.cappedTypes.length, 0);
  assert.equal(c.probability, 0.7);
});

test("an absence counts only when the model asserts its observation window", () => {
  const unasserted = computeProbability(L({
    base_rate: 0.4,
    base_rate_source: "x",
    entries: [
      { claim: "no reports yet", evidence_type: "absence", direction: "-" },
      { claim: "no announcement yet", evidence_type: "absence", direction: "-" },
    ],
  }));
  assert.equal(unasserted.totalPoints, 0, "absence without a window is not evidence");
  assert.equal(unasserted.droppedAbsence, 2);
  assert.equal(unasserted.probability, 0.4);

  const asserted = computeProbability(L({
    base_rate: 0.4,
    base_rate_source: "x",
    entries: Array.from({ length: 3 }, () => ({
      claim: "no reports, and this would certainly have been reported",
      evidence_type: "absence" as const,
      direction: "-" as const,
      observation_window_sufficient: true,
    })),
  }));
  assert.equal(asserted.totalPoints, -5, "asserted absence still caps at the type ceiling");
});

test("an unrecognised evidence type contributes nothing and is surfaced", () => {
  // Silently mapping it onto a real type would hide a prompt-compliance failure inside a score.
  const c = computeProbability(L({
    base_rate: 0.2,
    base_rate_source: "x",
    entries: [
      { claim: "c", evidence_type: "vibes" as never, direction: "+" },
    ],
  }));
  assert.equal(c.totalPoints, 0);
  assert.deepEqual(c.unknownTypes, ["vibes"]);
});

test("type names survive the casing and punctuation models actually emit", () => {
  const c = computeProbability(L({
    base_rate: 0.1,
    base_rate_source: "x",
    entries: [
      { claim: "a", evidence_type: "Already Happened" as never, direction: "+" },
      { claim: "b", evidence_type: "ALREADY-HAPPENED" as never, direction: "+" },
    ],
  }));
  assert.equal(c.unknownTypes.length, 0);
  assert.equal(c.totalPoints, 40);
});

test("the forecast never reaches 0 or 1, which Brier penalises without bound", () => {
  const entries = Array.from({ length: 9 }, () => ({
    claim: "settled",
    evidence_type: "already_happened" as const,
    direction: "+" as const,
  }));
  assert.equal(computeProbability(L({ base_rate: 0.5, entries })).probability, 0.99);
});

test("the ledger is read out of whatever the model wrapped it in", () => {
  const fenced = parseLedger(
    'thinking...\n```json\n{"base_rate":0.2,"base_rate_source":"s","entries":[]}\n```',
  );
  assert.equal(fenced?.base_rate, 0.2);

  const bare = parseLedger('prose {"base_rate":0.3,"base_rate_source":"s","entries":[]} trailing');
  assert.equal(bare?.base_rate, 0.3);

  // A model that reconsiders emits the corrected ledger last, so the last one wins.
  const revised = parseLedger(
    '{"base_rate":0.1,"base_rate_source":"s","entries":[]}\nOn reflection:\n' +
      '{"base_rate":0.6,"base_rate_source":"s","entries":[]}',
  );
  assert.equal(revised?.base_rate, 0.6);
});

test("a final answer with no ledger parses as null rather than as a guess", () => {
  // The caller turns this into a recorded ledger_parse_failed, so format failures can be
  // counted instead of being scored as bad forecasts.
  assert.equal(parseLedger("My final answer is *0.42*"), null);
  assert.equal(parseLedger('{"probability": 0.42}'), null);
});

test("the model's own probability and the shape fields are read off the ledger", () => {
  // These are what the run scores on and analyses by; the shadow table never touches them.
  const l = parseLedger(
    '```json\n{"question_shape":"any_point_in_window","window_days":308,' +
      '"base_rate":0.7,"base_rate_source":"s","entries":[],"final_probability":0.62}\n```',
  );
  assert.equal(l?.question_shape, "any_point_in_window");
  assert.equal(l?.window_days, 308);
  assert.equal(l?.final_probability, 0.62);
});

test("an unrecognised question_shape is recorded as absent rather than guessed", () => {
  const l = parseLedger('{"question_shape":"whenever","base_rate":0.2,"base_rate_source":"s","entries":[]}');
  assert.equal(l?.question_shape, null);
  assert.equal(l?.final_probability, null, "a ledger with no forecast must not invent one");
});
