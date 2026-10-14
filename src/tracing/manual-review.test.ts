import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendManualRetrievalReview } from "./manual-review.js";
import { TraceArchive } from "./trace-archive.js";

test("human reviews append to a separate hash-chained sidecar", () => {
  const root = mkdtempSync(join(tmpdir(), "fabench-manual-review-"));
  const archive = new TraceArchive({ resultsDir: root, tag: "review", run: {} });
  const blob = archive.storeTextBlob("review this body");
  const firstPath = appendManualRetrievalReview(archive.directory, {
    body_sha256: blob.sha256,
    url: "https://example.test/a",
    verdict: "leak",
    reason: "Settled outcome after anchor.",
    evidence_quote: "review this body",
    reviewer: "unit-test",
  });
  const secondPath = appendManualRetrievalReview(archive.directory, {
    body_sha256: blob.sha256,
    url: "https://example.test/a",
    verdict: "clean",
    reason: "Second independent review.",
    reviewer: "unit-test-2",
  });
  assert.equal(secondPath, firstPath);
  const rows = readFileSync(firstPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].previous_review_sha256, rows[0].review_sha256);
  assert.equal(rows[0].body_blob, blob.path);
  archive.finish("completed");
});

