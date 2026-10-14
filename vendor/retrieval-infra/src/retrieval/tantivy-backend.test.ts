import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TantivyBackend } from "./tantivy-backend.js";

test("Tantivy rejects an incompatible question before starting any search process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fabench-tantivy-anchor-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      policy: "tantivy-strict-cutoff-bm25-title3-body1-v2", anchor_ms: Date.parse("2026-03-01T00:00:00Z"),
      records_sha256: "a".repeat(64), tantivy_version: "0.25.1",
    }));
    const backend = new TantivyBackend(dir, "full", "/nonexistent-fixture-python");
    backend.assertAnchor("2026-03-01T00:00:00Z");
    assert.throws(() => backend.assertAnchor("2026-03-01"), /exact anchor/);
    await assert.rejects(backend.search("query", 10, "2026-02-01"), /exact anchor/);
    await assert.rejects(backend.fetch("https://a.test", "invalid"), /exact anchor/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
