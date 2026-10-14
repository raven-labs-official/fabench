import assert from "node:assert/strict";
import test from "node:test";
import { RetrievalInfrastructureError } from "../retrieval/infrastructure-error.js";
import { ArmCircuitBreakers, shouldPauseRetrievalArm } from "./arm-circuit-breaker.js";

test('reasoning replay incompatibility pauses web arms, ordinary page review failures stay local', () => {
  assert.equal(shouldPauseRetrievalArm(new RetrievalInfrastructureError('leak-filter','reasoning_replay_required','provider requires replay')),true);
  assert.equal(shouldPauseRetrievalArm(new RetrievalInfrastructureError('leak-filter','single_pass_provider_failed','one page failed')),false);
  assert.equal(shouldPauseRetrievalArm(new RetrievalInfrastructureError('page-dater','spawn_error','missing helper')),true);
});

test("arm circuit breaker opens only arms containing web-filter", () => {
  const circuits = new ArmCircuitBreakers(["web-filter", "both"]);
  const opened = circuits.openWebFilter(
    new RetrievalInfrastructureError(
      "page-dater",
      "spawn_error",
      "helper missing",
    ),
  );

  assert.deepEqual(opened, ["web-filter", "both"]);
  assert.equal(circuits.isOpen("none"), false);
  assert.equal(circuits.isOpen("frozen"), false);
  assert.equal(circuits.isOpen("web-filter"), true);
  assert.equal(circuits.isOpen("both"), true);
  circuits.noteSkipped("web-filter");
  assert.equal(
    circuits.snapshots().find((state) => state.arm === "web-filter")
      ?.skipped_cells,
    1,
  );
  assert.deepEqual(circuits.openWebFilter(
    new RetrievalInfrastructureError("search-provider", "later", "ignored"),
  ), []);
});
