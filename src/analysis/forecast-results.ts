import { commonLabels } from "./selection.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { canonicalArmSpec } from "../experiments/experiment-identity.js";

export interface PerQuestion {
  question_id: string;
  outcome: 0 | 1 | null;
  forecasts: Record<string, number | null>;
}

export interface ResourceRow {
  arm: string;
  cells: number;
  reused?: number;
  resourceScope?:
    "all-cells" | "new-cells-only; reused-cell resources remain in source runs";
  failed: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanToolCalls: number;
  meanSeconds: number;
  meanCostUsd: number | null;
  totalCostUsd: number | null;
}

export interface RunFile {
  path: string;
  tag: string;
  llm: string;
  maxToolCalls: number | undefined;
  runAtUtc: string | undefined;
  perQuestion: PerQuestion[];
  byId: Map<string, PerQuestion>;
  resources: ResourceRow[] | undefined;
}

export function loadRun(path: string): RunFile {
  let raw: {
    config?: {
      llm?: string;
      maxToolCalls?: number;
      maxSearches?: number;
      runAtUtc?: string;
    };
    perQuestion?: PerQuestion[];
    resources?: ResourceRow[];
  };
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: cannot read — ${(e as Error).message}`);
  }
  if (!raw.perQuestion?.length)
    throw new Error(
      `${path}: no perQuestion field — not an exp:forecast-value result file, or the run failed before writing results`,
    );
  const m = basename(path).match(/^forecast-value-(.+)\.json$/);
  const perQuestion = raw.perQuestion.map((question) => ({
    ...question,
    forecasts: Object.fromEntries(
      Object.entries(question.forecasts).map(([arm, value]) => [
        canonicalArmSpec(arm).canonical,
        value,
      ]),
    ),
  }));
  const resources = raw.resources?.map((row) => ({
    ...row,
    arm: canonicalArmSpec(row.arm).canonical,
  }));
  return {
    path,
    tag: m?.[1] ?? basename(path),
    llm: raw.config?.llm ?? "(unknown llm)",
    maxToolCalls: raw.config?.maxToolCalls ?? raw.config?.maxSearches,
    runAtUtc: raw.config?.runAtUtc,
    perQuestion,
    byId: new Map(perQuestion.map((p) => [p.question_id, p])),
    resources,
  };
}

/** Keep question IDs whose labels are present and agree across every run. */
export function commonQuestions(runs: RunFile[]) {
  return commonLabels(
    runs.map((run) => run.byId),
    runs[0]!.perQuestion.map((q) => q.question_id),
  );
}
