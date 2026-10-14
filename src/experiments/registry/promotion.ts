/** Audited promotion of existing results onto a modern condition id. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sha256Json, verifyTraceFile } from "../../tracing/trace-archive.js";
import { parseRegistryObject } from "../registry-json.js";
import { nowIso } from "./liveness.js";
import { importTraceArchive } from "./trace-import.js";
import type {
  PromoteEquivalentConditionInput,
  PromoteEquivalentConditionResult,
  PromoteLegacyClosedBookInput,
  PromoteLegacyClosedBookResult,
} from "./types.js";

function conditionTreatmentIdentity(
  condition: Record<string, unknown>,
): Record<string, unknown> {
  const comparable = { ...condition };
  // A smoke sample and its formal completion intentionally have different sample IDs.
  // A code-only release creates a different condition ID/fingerprint even when the
  // treatment is unchanged. No other condition field may differ during promotion.
  delete comparable.condition_id;
  delete comparable.code_fingerprint_sha256;
  delete comparable.question_sample_id;
  // These fields were added to the condition schema after early Frozen runs.
  // For a non-filtered arm, absent and explicit null both mean "no fallback
  // filter configured". Keep this compatibility list narrow: any non-null
  // value, or any difference in another treatment field, still refuses reuse.
  for (const key of ["filter_fallback_model", "filter_fallback_reasoning"])
    if (comparable[key] == null) delete comparable[key];
  return comparable;
}

/**
 * Explicitly map audited legacy closed-book results onto a modern condition id.
 *
 * This deliberately supports only `none`: a retrieval cell's budget, corpus and search
 * implementation affect its forecast, while a closed-book cell has no tools at all. The
 * source trace must prove that every promoted cell had tools disabled and provider-default
 * effort. INSERT OR IGNORE preserves any result produced natively under the modern schema.
 */
export function promoteLegacyClosedBook(
  db: DatabaseSync,
  input: PromoteLegacyClosedBookInput,
): PromoteLegacyClosedBookResult {
  const reason = input.reason.trim();
  if (!reason) throw new Error(`legacy promotion requires a non-empty audit reason`);
  if (!input.conditionId.trim() || input.conditionId.startsWith("legacy:"))
    throw new Error(`target conditionId must be an explicit modern condition`);
  if (!input.expectedModel.trim()) throw new Error(`expectedModel is required`);

  const directory = resolve(input.directory);
  const manifestRaw = readFileSync(join(directory, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  const runId = String(manifest.run_id ?? "");
  const runConfig = (manifest.run ?? {}) as Record<string, unknown>;
  const llmClient = (runConfig.llm_client ?? {}) as Record<string, unknown>;
  const sourceModel = String(llmClient.id ?? runConfig.llm ?? "");
  if (!runId || runId === "undefined") throw new Error(`source manifest has no run_id`);
  if (manifest.status !== "completed")
    throw new Error(`source run ${runId} is not completed`);
  if (sourceModel !== input.expectedModel)
    throw new Error(
      `source model ${sourceModel || "(missing)"} != expected ${input.expectedModel}`,
    );

  const lines = readFileSync(join(directory, "cells.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  const eligible = new Map<
    string,
    { probability: number; tracePath: string; predictorId: string }
  >();
  let rejected = 0;
  for (const line of lines) {
    const row = JSON.parse(line) as Record<string, unknown>;
    if (row.arm !== "none") continue;
    const probability = row.probability;
    const questionId = typeof row.question_id === "string" ? row.question_id : "";
    const predictorId = typeof row.predictor_id === "string" ? row.predictor_id : "";
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : null;
    const relativeTrace = typeof row.trace_file === "string" ? row.trace_file : "";
    const tracePath = resolve(directory, relativeTrace);
    const insideArchive = tracePath.startsWith(`${directory}${sep}`);
    if (
      row.status !== "success" ||
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1 ||
      !questionId ||
      predictorId !== `agentic:${input.expectedModel}:closed-book:n0` ||
      !toolCalls ||
      toolCalls.length !== 0 ||
      !relativeTrace ||
      !insideArchive ||
      !existsSync(tracePath)
    ) {
      rejected++;
      continue;
    }
    const verification = verifyTraceFile(tracePath);
    if (!verification.ok || !verification.complete) {
      rejected++;
      continue;
    }
    const attempts = readFileSync(tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((event) => JSON.parse(event) as Record<string, unknown>)
      .filter((event) => event.type === "model_attempt_started")
      .map((event) => (event.data ?? {}) as Record<string, unknown>);
    if (
      !attempts.length ||
      attempts.some(
        (attempt) => attempt.tools_enabled !== false || attempt.effort != null,
      )
    ) {
      rejected++;
      continue;
    }
    eligible.set(questionId, { probability, tracePath, predictorId });
  }

  // Make the historical run visible first. It remains legacy/display-only until the
  // narrowly audited rows below are mapped to this one explicit target condition.
  importTraceArchive(db, directory);
  const promotedAt = nowIso();
  const manifestSha256 = createHash("sha256").update(manifestRaw).digest("hex");
  const insert = db.prepare(`
      INSERT OR IGNORE INTO canonical_cells (
        condition_id, question_id, arm, probability, source_run_id,
        trace_path, summary_json, completed_at_utc
      ) VALUES (?, ?, 'none', ?, ?, ?, ?, ?)
    `);
  let inserted = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [questionId, cell] of eligible) {
      const result = insert.run(
        input.conditionId,
        questionId,
        cell.probability,
        runId,
        cell.tracePath,
        JSON.stringify({
          audited_legacy_closed_book_promotion: true,
          audit_reason: reason,
          promoted_at_utc: promotedAt,
          source_manifest_sha256: manifestSha256,
          source_model: sourceModel,
          source_predictor_id: cell.predictorId,
        }),
        promotedAt,
      );
      inserted += Number(result.changes > 0);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }
  return {
    sourceRunId: runId,
    eligible: eligible.size,
    inserted,
    alreadyPresent: eligible.size - inserted,
    rejected,
  };
}

/**
 * Map trace-verified successes across a code-only condition fingerprint change.
 *
 * This is deliberately explicit and narrow. The source and target treatment must be
 * byte-for-byte equivalent after removing only the generated condition id, source
 * fingerprint, and smoke/formal sample id. Every source cell is independently hash-
 * verified and must end in a matching successful `cell_finished` event. The source
 * canonical rows remain untouched; the inserted target rows carry an audit receipt.
 */
export function promoteEquivalentCondition(
  db: DatabaseSync,
  input: PromoteEquivalentConditionInput,
): PromoteEquivalentConditionResult {
  const reason = input.reason.trim();
  const sourceConditionId = input.sourceConditionId.trim();
  const targetConditionId =
    typeof input.targetCondition.condition_id === "string"
      ? input.targetCondition.condition_id.trim()
      : "";
  if (!reason) throw new Error(`equivalent promotion requires a non-empty audit reason`);
  if (!sourceConditionId || sourceConditionId.startsWith("legacy:"))
    throw new Error(`source conditionId must be an explicit modern condition`);
  if (!targetConditionId || targetConditionId.startsWith("legacy:"))
    throw new Error(`target condition must contain an explicit modern condition_id`);
  if (sourceConditionId === targetConditionId)
    throw new Error(`source and target condition ids must differ`);

  const rows = db.prepare(`
      SELECT c.question_id, c.arm, c.probability, c.source_run_id,
             c.trace_path, c.summary_json, r.config_json
      FROM canonical_cells c
      JOIN runs r ON r.run_id=c.source_run_id
      WHERE c.condition_id=?
      ORDER BY c.question_id
    `).all(sourceConditionId) as unknown as Array<{
    question_id: string;
    arm: string;
    probability: number;
    source_run_id: string;
    trace_path: string | null;
    summary_json: string;
    config_json: string;
  }>;
  if (!rows.length)
    throw new Error(`source condition has no canonical cells: ${sourceConditionId}`);

  const targetIdentity = sha256Json(conditionTreatmentIdentity(input.targetCondition));
  const targetArm = String(input.targetCondition.arm ?? "");
  const targetFingerprint = String(
    input.targetCondition.code_fingerprint_sha256 ?? "",
  );
  if (!targetArm) throw new Error(`target condition is missing arm`);
  if (!targetFingerprint) throw new Error(`target condition is missing code fingerprint`);

  const verified = rows.map((row) => {
    const runConfig = parseRegistryObject<Record<string, unknown>>(
      row.config_json,
      `${row.source_run_id} config_json`,
    );
    const conditions = Array.isArray(runConfig.conditions)
      ? runConfig.conditions as Array<Record<string, unknown>>
      : [];
    const sourceCondition = conditions.find(
      (condition) => condition.condition_id === sourceConditionId,
    );
    if (!sourceCondition)
      throw new Error(
        `source run ${row.source_run_id} does not record condition ${sourceConditionId}`,
      );
    const sourceFingerprint = String(
      sourceCondition.code_fingerprint_sha256 ?? "",
    );
    if (!sourceFingerprint)
      throw new Error(`source condition is missing code fingerprint`);
    if (
      row.arm !== targetArm ||
      sha256Json(conditionTreatmentIdentity(sourceCondition)) !== targetIdentity
    ) {
      throw new Error(
        `source and target treatments differ for ${row.question_id}; promotion refused`,
      );
    }
    if (!row.trace_path || !existsSync(row.trace_path))
      throw new Error(`source trace is missing for ${row.question_id}`);
    const verification = verifyTraceFile(row.trace_path);
    if (!verification.ok || !verification.complete)
      throw new Error(`source trace is incomplete or hash-invalid for ${row.question_id}`);
    const events = readFileSync(row.trace_path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const finished = [...events].reverse().find((event) => event.type === "cell_finished");
    const finalData = (finished?.data ?? {}) as Record<string, unknown>;
    if (
      finalData.status !== "success" ||
      finalData.question_id !== row.question_id ||
      typeof finalData.probability !== "number" ||
      Math.abs(finalData.probability - row.probability) > 1e-12
    ) {
      throw new Error(`source trace result does not match canonical row for ${row.question_id}`);
    }
    return { ...row, sourceFingerprint };
  });

  const promotedAt = nowIso();
  const insert = db.prepare(`
      INSERT OR IGNORE INTO canonical_cells (
        condition_id, question_id, arm, probability, source_run_id,
        trace_path, summary_json, completed_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  let inserted = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of verified) {
      const sourceSummary = parseRegistryObject<Record<string, unknown>>(
        row.summary_json,
        `${row.source_run_id}/${sourceConditionId}/${row.question_id} summary_json`,
      );
      const result = insert.run(
        targetConditionId,
        row.question_id,
        row.arm,
        row.probability,
        row.source_run_id,
        row.trace_path,
        JSON.stringify({
          ...sourceSummary,
          equivalent_condition_promotion: {
            reason,
            promoted_at_utc: promotedAt,
            source_condition_id: sourceConditionId,
            target_condition_id: targetConditionId,
            source_code_fingerprint_sha256: row.sourceFingerprint,
            target_code_fingerprint_sha256: targetFingerprint,
            trace_verified: true,
          },
        }),
        promotedAt,
      );
      inserted += Number(result.changes > 0);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }
  return {
    sourceConditionId,
    targetConditionId,
    eligible: verified.length,
    inserted,
    alreadyPresent: verified.length - inserted,
  };
}
