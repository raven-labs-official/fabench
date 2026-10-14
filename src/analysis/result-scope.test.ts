import assert from "node:assert/strict";
import test from "node:test";

import { classifyResultScope } from "./result-scope.js";

test("classifies small samples as smoke without excluding them", () => {
  assert.equal(classifyResultScope(1, 80), "smoke");
  assert.equal(classifyResultScope(79, 80), "smoke");
});

test("classifies samples at or above the publication floor as benchmark", () => {
  assert.equal(classifyResultScope(80, 80), "benchmark");
  assert.equal(classifyResultScope(300, 80), "benchmark");
});

test("rejects invalid question counts", () => {
  assert.throws(() => classifyResultScope(0, 80), /positive integer/);
  assert.throws(() => classifyResultScope(5, 0), /positive integer/);
});
