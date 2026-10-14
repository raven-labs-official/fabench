import assert from "node:assert/strict";
import test from "node:test";
import { buildExperimentAlert, type ExperimentAlertInput } from "./experiment-alert.js";

function input(event: ExperimentAlertInput["event"]): ExperimentAlertInput {
  return {
    event,
    owner: "alice",
    pid: 1234,
    release: "/srv/shared/releases/raven-bench/abc123",
    exitCode: event === "start" ? null : 143,
    signal: event === "interrupted" ? "SIGTERM" : null,
    experimentArgs: [
      "--n", "300",
      "--settings", "frozen",
      "--llm", "bailian:qwen3.8-27b",
      "--conc", "6",
      "--max-tool-calls", "50",
      "--tag", "qwen-frozen",
      "--api-key", "must-never-appear",
    ],
    occurredAtUtc: "2026-08-30T21:00:00.000Z",
  };
}

test("start alert contains the safe experiment card fields and omits unknown secrets", () => {
  const message = JSON.stringify(buildExperimentAlert(input("start")));
  assert.match(message, /Experiment started/);
  assert.match(message, /qwen-frozen/);
  assert.match(message, /qwen3\.8-27b/);
  assert.match(message, /frozen/);
  assert.match(message, /abc123/);
  assert.doesNotMatch(message, /must-never-appear/);
});

test("interruption alert is red and includes the signal and exit code", () => {
  const message = buildExperimentAlert({...input("interrupted"),reason:"Kimi 5-hour quota exhausted"});
  const encoded = JSON.stringify(message);
  assert.equal((message.card as { header: { template: string } }).header.template, "red");
  assert.match(encoded, /Experiment interrupted/);
  assert.match(encoded, /SIGTERM/);
  assert.match(encoded, /exit=143/);
  assert.match(encoded, /Kimi 5-hour quota exhausted/);
});
