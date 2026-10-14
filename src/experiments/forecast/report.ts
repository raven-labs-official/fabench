import {
  brierCI,
  brierIndex,
  brierIndexInterval,
  bssCI,
  pairedBrierDiff,
} from "../../scoring/bootstrap.js";
import { expectedCalibrationError } from "../../scoring/brier.js";
import type { Question } from "../../types.js";

import type { TopicInfo } from "./questions.js";
import type { ResourceRow } from "./resources.js";

/** Score successful forecasts, compare paired cells, and print the quality tables. */
export function reportForecastQuality({
  columns,
  forecasts,
  outcomes,
  questions,
  topics,
  iters,
}: {
  columns: string[];
  forecasts: Record<string, (number | null)[]>;
  outcomes: (0 | 1)[];
  questions: Question[];
  topics: Record<string, TopicInfo>;
  iters: number;
}) {
  const rows: unknown[] = [];
  const pairs: unknown[] = [];
  const byTopic: unknown[] = [];
  const baseline = columns[0]!;
  const base = forecasts[baseline]!;

  // Drop cells this arm failed on (null), keeping outcomes aligned. Per-arm metrics score only
  // that arm's successful cells; no cell is ever counted as a defaulted 0.5.
  const nn = (f: (number | null)[]) => {
    const F: number[] = [];
    const O: (0 | 1)[] = [];
    f.forEach((p, i) => {
      if (p != null) {
        F.push(p);
        O.push(outcomes[i] as 0 | 1);
      }
    });
    return { f: F, o: O };
  };
  // Paired metrics (BSS, paired diff) need the SAME cells for both arms: keep only where both
  // the arm and the baseline succeeded.
  const nnPair = (a: (number | null)[], b: (number | null)[]) => {
    const A: number[] = [];
    const B: number[] = [];
    const O: (0 | 1)[] = [];
    a.forEach((p, i) => {
      if (p != null && b[i] != null) {
        A.push(p);
        B.push(b[i] as number);
        O.push(outcomes[i] as 0 | 1);
      }
    });
    return { a: A, b: B, o: O };
  };

  console.log(
    `\n── Forecast quality (baseline = ${baseline}; n = scored cells per arm) ──`,
  );
  console.log(
    `arm               n   Brier Index [95% CI]          BSS vs ${baseline} [95% CI]        ECE    mean p`,
  );
  for (const label of columns) {
    const { f, o } = nn(forecasts[label]!);
    const b = brierCI(f, o, iters);
    const bi = brierIndexInterval(b);
    let s: ReturnType<typeof bssCI> | null = null;
    if (label !== baseline) {
      const pr = nnPair(forecasts[label]!, base);
      s = bssCI(pr.a, pr.b, pr.o, iters);
    }
    const ece = expectedCalibrationError(f, o);
    const meanP = f.length ? f.reduce((x, y) => x + y, 0) / f.length : NaN;
    console.log(
      `  ${label.padEnd(14)} ${String(f.length).padStart(3)}  ${bi.point.toFixed(2)} [${bi.lo.toFixed(2)},${bi.hi.toFixed(2)}]       ` +
        (s
          ? `${(s.point >= 0 ? "+" : "") + s.point.toFixed(4)} [${s.lo.toFixed(4)},${s.hi.toFixed(4)}]`
          : "        (baseline)      ") +
        `   ${ece.toFixed(3)}  ${meanP.toFixed(3)}`,
    );
    rows.push({
      arm: label,
      n: f.length,
      brierIndex: bi,
      brier: b,
      bss: s,
      ece,
      meanP,
    });
  }

  console.log(
    `\n── Paired difference vs ${baseline} (positive = arm is better) ──`,
  );
  for (const label of columns) {
    if (label === baseline) continue;
    // pairedBrierDiff returns Brier(A) − Brier(B) with A = baseline, so a POSITIVE value means
    // the baseline is worse, i.e. the arm helped. Its `probAbetter` is the fraction of
    // resamples where the BASELINE wins, so P(arm better) is its complement. Getting that
    // backwards prints a confident number with the wrong sign.
    const pr = nnPair(base, forecasts[label]!);
    const d = pairedBrierDiff(pr.a, pr.b, pr.o, iters);
    const sig = d.lo > 0 || d.hi < 0 ? "significant" : "not significant";
    console.log(
      `  ${label.padEnd(14)} Brier(${baseline}) − Brier(arm) = ${(d.diff >= 0 ? "+" : "") + d.diff.toFixed(4)} ` +
        `[${d.lo.toFixed(4)},${d.hi.toFixed(4)}]  P(arm better)=${(1 - d.probAbetter).toFixed(2)}  ${sig}`,
    );
    pairs.push({ arm: label, diff: d });
  }

  console.log(`\n── Brier Index by topic ──`);
  const topicList = [
    ...new Set(questions.map((q) => topics[q.question_id]?.topic ?? "unknown")),
  ];
  console.log(
    `topic                        n   ${columns.map((l) => l.padEnd(12)).join(" ")}`,
  );
  for (const t of topicList) {
    const idx = questions
      .map((q, i) => [q, i] as const)
      .filter(([q]) => (topics[q.question_id]?.topic ?? "unknown") === t)
      .map(([, i]) => i);
    const cellVals = columns.map((l) => {
      // Exclude cells this arm failed on within the topic; null is never scored as 0.5.
      const fo = idx
        .map((i) => [forecasts[l]![i], outcomes[i]] as const)
        .filter(([p]) => p != null) as [number, number][];
      return fo.length
        ? fo.reduce((s, [p, y]) => s + (p - y) ** 2, 0) / fo.length
        : NaN;
    });
    const indexVals = cellVals.map(brierIndex);
    console.log(
      `  ${t.padEnd(26)} ${String(idx.length).padStart(2)}   ${indexVals.map((c) => c.toFixed(2).padEnd(12)).join(" ")}`,
    );
    byTopic.push({
      topic: t,
      n: idx.length,
      brierIndex: Object.fromEntries(columns.map((l, i) => [l, indexVals[i]])),
      brier: Object.fromEntries(columns.map((l, i) => [l, cellVals[i]])),
    });
  }

  return { baseline, rows, pairs, byTopic };
}

export function reportForecastResources(resourceRows: ResourceRow[]): void {
  console.log(`\n── Resources per question (mean) ──`);
  console.log(
    `arm              input tok   output tok  tool calls  s/question  $/question`,
  );
  for (const row of resourceRows) {
    console.log(
      `  ${row.arm.padEnd(14)} ${String(row.meanInputTokens).padStart(9)}   ${String(row.meanOutputTokens).padStart(9)}   ${String(row.meanToolCalls).padStart(7)}   ${String(row.meanSeconds).padStart(6)}   ` +
        `${row.meanCostUsd == null ? "unpriced" : `$${row.meanCostUsd.toFixed(4)}`}` +
        (row.reused ? `   (${row.reused} cells reused; this row counts new calls only)` : "") +
        (row.failed ? `   (${row.failed} cells failed; not in the means)` : ""),
    );
  }
  console.log(`\n── Tool budget reached (shared by search and fetch) ──`);
  console.log(`arm              max calls  reached/evaluated  requested beyond budget`);
  for (const row of resourceRows) {
    console.log(
      `  ${row.arm.padEnd(14)} ${String(row.maxToolCalls).padStart(8)}   ` +
        `${String(row.budgetReachedCells).padStart(3)}/${String(row.budgetEvaluatedCells).padEnd(3)} ` +
        `${(row.budgetReachedRate * 100).toFixed(1).padStart(5)}%   ` +
        `${String(row.overBudgetRequestCells).padStart(3)}/${String(row.budgetEvaluatedCells).padEnd(3)} ` +
        `${(row.overBudgetRequestRate * 100).toFixed(1).padStart(5)}%`,
    );
  }
  console.log(`\n── Retrieval and stage time per question (mean) ──`);
  console.log(
    `arm              search  fetch  URLs returned  unique URLs  full reads  full-text chars  model time  tool time`,
  );
  for (const row of resourceRows) {
    console.log(
      `  ${row.arm.padEnd(14)} ${String(row.meanSearchCalls).padStart(4)}   ` +
        `${String(row.meanFetchCalls).padStart(4)}   ${String(row.meanReturnedUrls).padStart(7)}   ` +
        `${String(row.meanUniqueReturnedUrls).padStart(7)}   ${String(row.meanFetchedDocuments).padStart(6)}   ` +
        `${String(row.meanFetchedDocumentChars).padStart(8)}   ` +
        `${(row.modelTimeShare * 100).toFixed(1).padStart(6)}%   ` +
        `${(row.toolTimeShare * 100).toFixed(1).padStart(6)}%`,
    );
  }
}
