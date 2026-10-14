import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditExposure, inspectVisibleContent } from "./exposure-audit.js";

test("exposure audit distinguishes exact timestamps, date-only ambiguity, and market mentions", () => {
  const findings = inspectVisibleContent(
    {
      results: [
        {
          url: "https://example.org/a",
          publishedDate: "2026-07-01T23:21:00Z",
          text: "Polymarket prices the contract at 48%.",
        },
        {
          publishedDate: "2026-07-01",
          text: "The forecast target is 2026-10-01.",
        },
        {
          publishedDate: "2026-07-01T07:00:00+08:00",
          text: "Inflation is 3%.",
        },
      ],
    },
    "2026-07-01T00:00:00Z",
  );
  assert.deepEqual(
    findings.map((f) => f.kind),
    ["date_not_before_anchor", "market_price_mention", "same_day_unknown_time"],
  );
});

test("exposure audit scans only delivered content and reports missing blobs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "exposure-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "cells"));
  mkdirSync(join(root, "blobs"));
  const text = "Polymarket gives the event a 48% chance.";
  const sha256 = createHash("sha256").update(text).digest("hex");
  writeFileSync(join(root, "blobs", sha256 + ".txt"), text);
  const events = [
    {
      type: "cell_started",
      data: {
        question_id: "q",
        arm: "web-filter",
        as_of: "2026-07-01T00:00:00Z",
      },
    },
    { type: "retrieval_audit", data: { rejected: text } },
    { type: "assistant_message", data: { content: text } },
    {
      type: "tool_call_finished",
      sequence: 3,
      data: {
        name: "web_fetch",
        model_visible_content: {
          text_blob: { path: `blobs/${sha256}.txt`, sha256 },
        },
      },
    },
    {
      type: "tool_call_finished",
      sequence: 4,
      data: {
        name: "web_fetch",
        model_visible_content: {
          text_blob: { path: "blobs/missing.txt", sha256 },
        },
      },
    },
  ];
  const path = join(root, "cells", "q.jsonl");
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n"));
  const result = auditExposure(path);
  assert.equal(result.visible_responses, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.sequence, 3);
  assert.equal(result.issues.length, 1);
});
