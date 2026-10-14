/** Compare forecast-value result files on their shared, consistently labelled questions. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  brierCI,
  brierIndexInterval,
  pairedBrierDiff,
} from "../scoring/bootstrap.js";
import { expectedCalibrationError } from "../scoring/brier.js";

import {
  commonQuestions,
  loadRun,
  type ResourceRow,
  type RunFile,
} from "./forecast-results.js";

function usage(msg?: string): never {
  if (msg) console.error(`\n${msg}`);
  console.error(
    `\nusage: pnpm exp:leaderboard -- <forecast-value-*.json> [<more>...] [--iters 2000] [--output-dir <directory>]\n` +
      `  Each file is a result JSON written by exp:forecast-value; the leaderboard rescores only the questions all runs share.\n`,
  );
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const files: string[] = [];
  let iters = 2000;
  let outputDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue; // pnpm forwards the separator itself
    if (a === "--iters") {
      iters = Number(argv[++i]);
      if (!Number.isFinite(iters) || iters < 1) usage(`--iters must be a positive integer`);
      continue;
    }
    if (a === "--output-dir") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) usage("--output-dir requires a directory path");
      outputDir = resolve(value);
      continue;
    }
    if (a.startsWith("--")) usage(`Unknown argument ${a}`);
    files.push(a);
  }
  if (!files.length) usage();
  outputDir ??= (await import("../paths.js")).RESULTS_DIR;
  let runs: RunFile[];
  try {
    runs = files.map(loadRun);
  } catch (error) {
    usage((error as Error).message);
  }

  console.log(`=== leaderboard · ${runs.length} runs ===`);
  for (const r of runs)
    console.log(
      `    ${r.tag.padEnd(16)} llm=${r.llm}  n=${r.perQuestion.length}  ` +
        `max-tool-calls=${r.maxToolCalls ?? "?"}  ${r.runAtUtc?.slice(0, 16) ?? ""}`,
    );
  const budgets = new Set(runs.map((r) => r.maxToolCalls));
  if (budgets.size > 1)
    console.log(
      `    ⚠️ runs differ in --max-tool-calls (${[...budgets].join(", ")}): a cell changed both model and budget, so a score gap cannot be attributed to either`,
    );

  const { commonIds, conflicting } = commonQuestions(runs);
  if (conflicting)
    console.log(
      `    ⚠️ dropped ${conflicting} questions whose outcome differs between runs (did the answer file change?)`,
    );
  if (!commonIds.length) {
    console.error(`\n❌ The runs share no questions; nothing to compare.`);
    process.exit(1);
  }
  const outcomes = commonIds.map(
    (id) => runs[0]!.byId.get(id)!.outcome as 0 | 1,
  );
  console.log(`    ${commonIds.length} shared questions (other questions of each run are left out)\n`);

  interface Entry {
    run: string;
    llm: string;
    arm: string;
    brier: { point: number; lo: number; hi: number };
    brierIndex: { point: number; lo: number; hi: number };
    ece: number;
    meanP: number;
    res: ResourceRow | undefined;
    vector: number[];
  }
  const entries: Entry[] = [];
  for (const r of runs) {
    const arms = Object.keys(r.perQuestion[0]!.forecasts ?? {});
    for (const arm of arms) {
      const vector = commonIds.map((id) => r.byId.get(id)!.forecasts[arm]);
      if (vector.some((v) => typeof v !== "number")) {
        console.log(`    ⚠️ ${r.tag}/${arm}: some questions have no forecast; column skipped`);
        continue;
      }
      const v = vector as number[];
      const brier = brierCI(v, outcomes, iters);
      entries.push({
        run: r.tag,
        llm: r.llm,
        arm,
        brier,
        brierIndex: brierIndexInterval(brier),
        ece: expectedCalibrationError(v, outcomes),
        meanP: v.reduce((a, b) => a + b, 0) / v.length,
        res: r.resources?.find((x) => x.arm === arm),
        vector: v,
      });
    }
  }

  // One board per evidence arm. Ranking a closed-book cell against a frozen-archive cell
  // would rank two different experiments; within an arm, the only thing varying is the model.
  const armOrder = [...new Set(entries.map((e) => e.arm))];
  const boards = armOrder.map((arm) => {
    const list = entries
      .filter((e) => e.arm === arm)
      .sort((a, b) => a.brier.point - b.brier.point);
    return { arm, list };
  });

  const fmtRes = (res: ResourceRow | undefined) => {
    if (!res) return `      —            —       —`;
    const incremental =
      res.resourceScope?.startsWith("new-cells-only") || (res.reused ?? 0) > 0;
    return (
      `${String(res.meanInputTokens).padStart(7)}→${String(res.meanOutputTokens).padEnd(6)} ${String(res.meanSeconds.toFixed(0)).padStart(4)}s  ` +
      `${res.meanCostUsd == null ? "unpriced" : `$${res.meanCostUsd.toFixed(4)}`}` +
      (incremental ? "*" : "")
    );
  };

  for (const { arm, list } of boards) {
    console.log(`── ${arm} · ${commonIds.length} questions ──`);
    console.log(
      `  #  run/llm                      Brier Index [95% CI]     vs leader (paired raw Brier difference)  tok in→out   s/q     $/q       ECE`,
    );
    const leader = list[0]!;
    list.forEach((e, i) => {
      let vsLeader = "(leader)";
      if (e !== leader) {
        // pairedBrierDiff(A, B) = Brier(A) − Brier(B); positive = A worse = behind.
        const gap = pairedBrierDiff(e.vector, leader.vector, outcomes, iters);
        const sig = gap.lo > 0 ? "significantly behind" : "not significant";
        vsLeader = `+${gap.diff.toFixed(4)} [${gap.lo.toFixed(3)},${gap.hi.toFixed(3)}] ${sig}`;
      }
      console.log(
        `  ${i + 1}  ${`${e.run} · ${e.llm}`.padEnd(28).slice(0, 28)} ` +
          `${e.brierIndex.point.toFixed(2)} [${e.brierIndex.lo.toFixed(2)},${e.brierIndex.hi.toFixed(2)}]  ` +
          `${vsLeader.padEnd(34)} ${fmtRes(e.res)}   ${e.ece.toFixed(3)}`,
      );
    });
    if (
      list.some(
        (entry) =>
          entry.res?.resourceScope?.startsWith("new-cells-only") ||
          (entry.res?.reused ?? 0) > 0,
      )
    ) {
      console.log(
        "     * Resource means count only new calls in this run; reused cells keep their resources in the original run.",
      );
    }
    console.log();
  }

  mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, "leaderboard.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAtUtc: new Date().toISOString(),
        bootstrapIters: iters,
        commonQuestions: commonIds.length,
        conflictingOutcomesDropped: conflicting,
        runs: runs.map((r) => ({
          tag: r.tag,
          llm: r.llm,
          n: r.perQuestion.length,
          maxToolCalls: r.maxToolCalls,
          runAtUtc: r.runAtUtc,
          path: r.path,
        })),
        boards: boards.map(({ arm, list }) => ({
          arm,
          entries: list.map(({ vector: _v, res, ...e }) => ({
            ...e,
            resources: res ?? null,
          })),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`Leaderboard → ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
