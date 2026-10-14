/** Append-only human review sidecar for immutable retrieval traces. */
import {
  chmodSync,
  closeSync,
  existsSync,
  fdatasyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { TRACE_FILE_MODE, sha256, sha256Json } from "./trace-archive.js";

export const MANUAL_REVIEW_SCHEMA_VERSION = "raven.manual-retrieval-review.v1";

export interface ManualRetrievalReviewInput {
  body_sha256: string;
  url: string;
  verdict: "leak" | "clean" | "uncertain";
  reason: string;
  evidence_quote?: string;
  reviewer?: string;
}

export function appendManualRetrievalReview(
  archiveDirectory: string,
  input: ManualRetrievalReviewInput,
): string {
  if (!/^[0-9a-f]{64}$/.test(input.body_sha256))
    throw new Error("body_sha256 must be a lowercase SHA-256 digest");
  const blobPath = join(archiveDirectory, "blobs", `${input.body_sha256}.txt`);
  if (!existsSync(blobPath)) throw new Error(`reviewed body blob is missing: ${blobPath}`);
  const body = readFileSync(blobPath);
  if (sha256(body) !== input.body_sha256)
    throw new Error(`reviewed body blob hash mismatch: ${blobPath}`);
  if (input.evidence_quote && !body.toString("utf8").includes(input.evidence_quote))
    throw new Error("evidence_quote does not occur in the reviewed body blob");

  const path = join(archiveDirectory, "manual-reviews.jsonl");
  const existing = existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean)
    : [];
  let previous: string | null = null;
  for (const [index, line] of existing.entries()) {
    const row = JSON.parse(line) as Record<string, unknown>;
    const claimed = typeof row.review_sha256 === "string" ? row.review_sha256 : null;
    const base = { ...row };
    delete base.review_sha256;
    if (row.sequence !== index || row.previous_review_sha256 !== previous)
      throw new Error(`manual review sidecar chain is invalid at line ${index + 1}`);
    if (claimed !== sha256Json(base))
      throw new Error(`manual review sidecar hash is invalid at line ${index + 1}`);
    previous = claimed;
  }

  const base = {
    schema_version: MANUAL_REVIEW_SCHEMA_VERSION,
    sequence: existing.length,
    reviewed_at_utc: new Date().toISOString(),
    reviewer: input.reviewer?.trim() || process.env.USER?.trim() || "unknown",
    body_sha256: input.body_sha256,
    body_blob: `blobs/${input.body_sha256}.txt`,
    url: input.url,
    verdict: input.verdict,
    reason: input.reason,
    evidence_quote: input.evidence_quote ?? null,
    previous_review_sha256: previous,
  };
  const row = { ...base, review_sha256: sha256Json(base) };
  const fd = openSync(path, "a", TRACE_FILE_MODE);
  try {
    const data = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
    writeSync(fd, data, 0, data.length);
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, TRACE_FILE_MODE);
  return path;
}
