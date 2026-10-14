/**
 * Read again, under the current answer-reading policy, the cells of a prediction segment that
 * failed only because their final reply could not be read. Offline and read-only: no model
 * call, no registry write. The output is folded back with
 * `tools/prediction-segment.py --reread <out>`.
 *
 * Usage: tsx src/experiments/reread-segment-failures.ts SEGMENT_JSON QUESTIONS_JSONL OUT_JSON
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256, verifyTraceArchive } from "../tracing/trace-archive.js";
import { FORECAST_PARSE_POLICY, parseForecastAnswer } from "../predictors/forecast-response.js";
import { repairRawFinal } from "./repair-forecast-run.js";

interface ParseFailure {
  run_id: string; arm: string; question_id: string; updated_at_utc: string;
  trace_directory: string; trace_file?: string | null;
}

const lines = (path: string): any[] =>
  readFileSync(path, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line));

export function rereadCell(directory: string, failure: ParseFailure, unit: string | null) {
  const row = lines(join(directory, "cells.jsonl")).filter(r =>
    r.question_id === failure.question_id && r.arm === failure.arm && r.status === "failed");
  if (row.length !== 1 || !row[0].trace_file) throw new Error(`No single failed row for ${failure.run_id} ${failure.question_id}`);
  const events = lines(resolve(directory, row[0].trace_file));
  const started = events.find(e => e.type === "cell_started")?.data;
  if (started?.question_id !== failure.question_id || started?.arm !== failure.arm)
    throw new Error(`Trace does not belong to ${failure.question_id} ${failure.arm}`);
  const raw = repairRawFinal(events, row[0], true);
  const base = { run_id: failure.run_id, arm: failure.arm, question_id: failure.question_id,
    updated_at_utc: failure.updated_at_utc, parse_policy: FORECAST_PARSE_POLICY, raw_sha256: raw ? sha256(raw) : null };
  try {
    const { answer, format_repairs } = parseForecastAnswer(raw, unit);
    return { ...base, readable: true, format_repairs, probability_yes: answer.probability_yes,
      numeric_forecast: answer.numeric_forecast, error: null };
  } catch (error) {
    return { ...base, readable: false, format_repairs: [], probability_yes: null, numeric_forecast: null,
      error: (error as Error).message };
  }
}

function main() {
  const [segmentPath, questionsPath, outPath] = process.argv.slice(2);
  if (!segmentPath || !questionsPath || !outPath)
    throw new Error("Usage: reread-segment-failures.ts SEGMENT_JSON QUESTIONS_JSONL OUT_JSON");
  const segmentBytes = readFileSync(segmentPath);
  const questionBytes = readFileSync(questionsPath);
  const units = new Map(lines(questionsPath).map(q => [q.id, q.numeric_target_unit ?? null]));
  const failures = JSON.parse(segmentBytes.toString("utf8")).parse_failures as ParseFailure[];
  const verified = new Set<string>();
  const cells = failures.map(failure => {
    if (!units.has(failure.question_id)) throw new Error(`Question ${failure.question_id} is not in ${questionsPath}`);
    if (!verified.has(failure.trace_directory)) {
      const check = verifyTraceArchive(failure.trace_directory);
      if (!check.ok) throw new Error(`Trace archive ${failure.trace_directory} failed verification: ${check.issues.slice(0, 3).join("; ")}`);
      verified.add(failure.trace_directory);
    }
    return rereadCell(failure.trace_directory, failure, units.get(failure.question_id)!);
  });
  writeFileSync(outPath, JSON.stringify({
    policy: FORECAST_PARSE_POLICY, generated_at_utc: new Date().toISOString(), new_model_calls: 0,
    segment_sha256: sha256(segmentBytes), questions_sha256: sha256(questionBytes), cells,
  }, null, 2) + "\n");
  for (const c of cells)
    console.log(`${c.run_id.slice(0, 8)} ${c.arm} ${c.question_id} ${c.readable ? `readable ${c.format_repairs.join(",")}` : `unreadable: ${c.error}`}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
