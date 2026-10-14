/** Strict comparisons keep the same protocol and dataset while varying the model. */
import { createHash } from "node:crypto";
type Obj = Record<string, any>;
const hash = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
function stable(x: any): any {
  return Array.isArray(x)
    ? x.map(stable)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, stable(x[k])]),
        )
      : x;
}
export function comparisonKey(config: Obj, condition: Obj): string | null {
  const requiredIdentity = [
    config.question_set_id,
    config.question_set?.file_sha256,
    config.question_set?.grading_file_sha256,
    condition.condition_id,
    condition.code_fingerprint_sha256,
    condition.harness,
  ];
  if (requiredIdentity.some(value => typeof value !== "string" || !value.trim())) return null;
  const c = { ...condition };
  // Compare models only within otherwise identical protocol/harness conditions.
  for (const k of [
    "condition_id",
    "model",
    "model_endpoint",
    "question_sample_id",
  ])
    delete c[k];
  // Postprocess provenance is per run, but interpretation policy/code must match.
  if (c.interpretation) {
    c.interpretation = { ...c.interpretation };
    delete c.interpretation.source_run_id;
    delete c.interpretation.plan_sha256;
  }
  return hash(
    stable({
      condition: c,
      questionSetId: config.question_set_id,
      questionSet: config.question_set,
      mode: config.execution_mode ?? "strict",
      promptArtifact: config.question_set?.file_sha256 ?? null,
    }),
  );
}
