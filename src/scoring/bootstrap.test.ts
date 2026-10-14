import assert from "node:assert/strict";
import test from "node:test";
import { brierIndex, brierIndexInterval } from "./bootstrap.js";

test("Brier Index maps aggregate Brier scores onto the ForecastBench display scale", () => {
  assert.equal(brierIndex(0), 100);
  assert.equal(brierIndex(0.25), 50);
  assert.equal(brierIndex(1), 0);
  assert.ok(Math.abs(brierIndex(0.086) - 70.674243) < 1e-6);
});

test("Brier Index interval reverses the decreasing Brier bounds", () => {
  assert.deepEqual(brierIndexInterval({ point: 0.25, lo: 0.16, hi: 0.36 }), {
    point: 50,
    lo: 40,
    hi: 60,
  });
});
