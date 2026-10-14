/**
 * The probability parser is a correctness-critical seam: a misparse silently
 * turns a good forecast into garbage and corrupts every downstream Brier score.
 * These tests pin the two things that bite most — taking the FINAL number, and
 * clamping away from 0/1.
 *
 * Run: pnpm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProbability, CLAMP_MIN, CLAMP_MAX } from "./parse-probability.js";

test("prefers the asterisk-delimited final probability", () => {
  assert.equal(parseProbability("My reasoning... Final answer: *0.62*"), 0.62);
});

test("takes the LAST number, not an intermediate one", () => {
  const text =
    "Base rate is 0.30. Initial probability 0.45. " +
    "After calibration I adjust. Final: *0.55*";
  assert.equal(parseProbability(text), 0.55);
});

test("parses 'Probability: NN%' and converts to a fraction", () => {
  assert.equal(parseProbability("...rationale...\nProbability: 73%"), 0.73);
});

test("parses a labeled bare decimal", () => {
  assert.equal(parseProbability("So the probability is 0.08 given the evidence."), 0.08);
});

test("clamps extremes away from 0 and 1", () => {
  assert.equal(parseProbability("*1.0*"), CLAMP_MAX);
  assert.equal(parseProbability("*0*"), CLAMP_MIN);
  assert.equal(parseProbability("Probability: 100%"), CLAMP_MAX);
  assert.equal(parseProbability("Probability: 0%"), CLAMP_MIN);
});

test("asterisk form wins even when percentages appear earlier", () => {
  const text = "Reasons suggest about 40% to 60%. Final answer: *0.52*";
  assert.equal(parseProbability(text), 0.52);
});

test("returns null when no number is present", () => {
  assert.equal(parseProbability("I cannot determine this."), null);
  assert.equal(parseProbability(""), null);
});

test("falls back to a bare percentage when nothing better exists", () => {
  assert.equal(parseProbability("I'd say roughly 65% likely."), 0.65);
});
