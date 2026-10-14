import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rereadCell } from "./reread-segment-failures.js";

function archive(final: string) {
  const dir = mkdtempSync(join(tmpdir(), "reread-"));
  mkdirSync(join(dir, "cells"));
  const events = [
    { type: "cell_started", data: { question_id: "Q1", arm: "frozen" } },
    { type: "assistant_message", data: { content: final } },
    { type: "agent_failed", data: { error: "Forecast response is not one JSON object" } },
  ];
  writeFileSync(join(dir, "cells", "Q1--frozen.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "cells.jsonl"), JSON.stringify({ question_id: "Q1", arm: "frozen", status: "failed", trace_file: "cells/Q1--frozen.jsonl" }) + "\n");
  return dir;
}
const failure = (dir: string) => ({ run_id: "run-1", arm: "frozen", question_id: "Q1", updated_at_utc: "t", trace_directory: dir });

test("a trailing-comma reply that failed before is read under the current policy", () => {
  const dir = archive('{"probability_yes":0.4,"numeric_forecast":{"value":12,"unit":"mm"},"rationale":"Rain is likely.",\n}');
  try {
    const cell = rereadCell(dir, failure(dir), "mm");
    assert.equal(cell.readable, true);
    assert.equal(cell.probability_yes, 0.4);
    assert.deepEqual(cell.numeric_forecast, { value: 12, unit: "mm" });
    assert.deepEqual(cell.format_repairs, ["trailing_comma"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a reply that is still broken stays unreadable, and a trace for another question is refused", () => {
  const dir = archive('{"probability_yes":0.4,"numeric_forecast":null,"rationale":"x."," }');
  try {
    const cell = rereadCell(dir, failure(dir), null);
    assert.equal(cell.readable, false);
    assert.match(cell.error!, /not one JSON object/);
    assert.throws(() => rereadCell(dir, { ...failure(dir), question_id: "Q2" }, null), /No single failed row/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
