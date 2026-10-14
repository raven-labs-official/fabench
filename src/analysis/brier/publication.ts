import {
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import type { BrierReport } from "./report.js";

/** Write one immutable report snapshot and switch the current pointer. */
export function publishBrierReport(
  outputRoot: string,
  { answerTable, analysis }: BrierReport,
): void {
  const generatedAtUtc = analysis.generated_at_utc;
  const registryPath = analysis.registry_path;
  const stamp = generatedAtUtc.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const snapshotDir = join(outputRoot, "snapshots", `${stamp}-${process.pid}`);
  mkdirSync(snapshotDir, { recursive: true });

  const manifest = {
    schema_version: "raven.brier-analysis-snapshot.v1",
    generated_at_utc: generatedAtUtc,
    registry_path: registryPath,
    output_directory: snapshotDir,
    questions: answerTable.questions.length,
    groups: answerTable.groups.length,
    primary_groups: analysis.hardest_question_comparability.primary_groups,
    files: ["final-answer-table.json", "brier-analysis.json", "manifest.json"],
  };

  writeFileSync(
    join(snapshotDir, "final-answer-table.json"),
    `${JSON.stringify(answerTable, null, 2)}\n`,
  );
  writeFileSync(
    join(snapshotDir, "brier-analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
  );
  writeFileSync(
    join(snapshotDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  mkdirSync(outputRoot, { recursive: true });
  const currentPath = join(outputRoot, "current");
  const temporaryLink = join(outputRoot, `.current-${process.pid}`);
  rmSync(temporaryLink, { force: true });
  symlinkSync(relative(outputRoot, snapshotDir), temporaryLink, "dir");
  renameSync(temporaryLink, currentPath);
  const latestTmp = join(outputRoot, `.latest-${process.pid}.json`);
  writeFileSync(
    latestTmp,
    `${JSON.stringify({ ...manifest, current: relative(outputRoot, snapshotDir) }, null, 2)}\n`,
  );

  renameSync(latestTmp, join(outputRoot, "latest.json"));

  console.log(
    `[OK] Brier answer table: ${join(currentPath, "final-answer-table.json")}`,
  );
  console.log(
    `[OK] Brier analysis:     ${join(currentPath, "brier-analysis.json")}`,
  );
  console.log(`[OK] snapshot:           ${snapshotDir}`);
}
