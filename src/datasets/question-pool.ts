/**
 * Load questions from one JSONL file, for question sets produced by the `question-making/pool/`
 * pipeline.
 *
 * Why it exists: before it, the runner knew only the hard-coded `selected_300` set, so newly
 * written questions could not be run at all. If the question pipeline's output cannot be run,
 * there is no way to check whether questions selected by these criteria really measure the
 * effect of retrieval better — and that is the only acceptance test for question selection.
 *
 * Identity: the question set id carries a **hash of the file contents**, not the file name. The
 * registry deduplicates by `condition_id + question_id`, and the condition contains the question
 * set id; if the questions changed but the name stayed, old results would be reused as the same
 * experiment and two different batches of questions would be silently mixed in one table.
 *
 * Outcomes: embedded outcomes of historical pools are supported, as is a separate gradingPath.
 * Structured model input contains no answers. Both modes keep the following known boundary
 * when scoring, which only states the existing situation — `Question.ground_truth` has always
 * been loaded and scored in the same process (see section 2 of
 * docs/archive/research/validity-through-20260907.md, a known and documented weakness). This
 * module does one more thing: **`market_price_at_freeze` is always null**. The pool carries
 * `market_value_at_anchor`, the market price at the anchor; it is a leakage field and must never
 * flow along with the Question to the predictor.
 *
 * Expected fields per line (extra fields are ignored):
 *   uid / question_id   question id
 *   question            question text
 *   criteria            resolution criteria text, may be null
 *   anchor              forecast time (anchor)
 *   resolution_date     resolution deadline
 *   truth               0 or 1
 *   source_feed         source, copied into category for stratification
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { BetaRavenQuestion } from "./beta-raven-bench.js";

interface PoolRow {
  data_contract?: "raven.question.v3";
  cut_off_time?: string;
  id?: string;
  prompt?: string;
  question_en?: string;
  prediction_cutoff_utc?: string;
  response_format?: "raven.forecast.v2.1";
  numeric_target_unit?: string | null;
  uid?: string;
  question_id?: string;
  question?: string;
  question_text?: string;
  criteria?: string | null;
  resolution_criteria?: string | null;
  anchor?: string;
  as_of_date?: string;
  resolution_date?: string;
  truth?: number | null;
  ground_truth?: number | null;
  source_feed?: string;
}

interface GradeRow {
  id: string;
  answer?: number;
  resolution_result?: number;
  resolution_date?: string;
  numeric_result?: { value: number; unit: string } | null;
  /** Released grading keys leave out third-party numeric values (market prices, licensed index
   * levels) and keep the Yes/No outcome, which is all that scoring uses. */
  numeric_result_withheld?: boolean;
}

// A date-only value preserves day precision; do not fabricate a publication time.
function validResolutionDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const n = Date.parse(value);
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const n = Date.parse(value);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 19) === value.slice(0, 19);
}

export interface LoadedPool {
  /**
   * Reuses the `BetaRavenQuestion` shape rather than a bare `Question`: the runner's stratified
   * sampling, topic statistics and run card all read the domain / archetype / difficulty
   * fields. A narrower type would let a new question set silently degrade to empty values
   * there instead of failing at compile time. A new set has no hand-labelled topics, so it
   * records source_feed and "unlabelled" as they are.
   */
  questions: BetaRavenQuestion[];
  identity: {
    question_set_id: string;
    family: "question-pool";
    file: string;
    file_sha256: string;
    grading_file_sha256?: string;
    rows_in_file: number;
    rows_loaded: number;
  };
}

export function loadQuestionPool(path: string, gradingPath?: string): LoadedPool {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const questions: BetaRavenQuestion[] = [];
  const gradingRaw = gradingPath ? readFileSync(gradingPath, "utf8") : "";
  const grades = new Map<string, GradeRow>();
  for (const line of gradingRaw.split("\n").filter((l) => l.trim())) {
    const g = JSON.parse(line) as GradeRow;
    const answer = g.resolution_result ?? g.answer;
    if (!g.id || grades.has(g.id) || (answer !== 0 && answer !== 1) ||
        (g.answer !== undefined && g.resolution_result !== undefined && g.answer !== g.resolution_result))
      throw new Error("Invalid or duplicate separate grading key entry");
    grades.set(g.id, g);
  }
  const seen = new Set<string>();
  for (const [i, line] of lines.entries()) {
    let r: PoolRow;
    try {
      r = JSON.parse(line) as PoolRow;
    } catch {
      throw new Error(`${basename(path)} line ${i + 1} is not valid JSON`);
    }
    const id = r.question_id ?? r.uid ?? r.id;
    const text = r.question_text ?? r.question ?? r.question_en;
    const actualDateContract = r.data_contract === "raven.question.v3";
    const anchor = r.cut_off_time ?? r.as_of_date ?? r.anchor;
    const grade = grades.get(id ?? "");
    const truth = gradingPath ? grade?.resolution_result ?? grade?.answer : r.ground_truth ?? r.truth;
    const resolutionDate = actualDateContract ? grade?.resolution_date : r.resolution_date;
    if (id && seen.has(id)) throw new Error(`Duplicate question id: ${id}`);
    if (id) seen.add(id);
    if (actualDateContract) {
      if (!gradingPath || !grade || r.response_format !== "raven.forecast.v2.1")
        throw new Error(`Actual resolution contract requires separate grading key and structured prompt: ${id}`);
      // Any anchor is allowed; it must be one exact UTC second shared by both fields. The
      // frozen run also checks that its per-anchor index matches every question.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r.cut_off_time ?? "") ||
          new Date(Date.parse(r.cut_off_time!)).toISOString() !== r.cut_off_time!.replace("Z", ".000Z") ||
          r.as_of_date !== r.cut_off_time)
        throw new Error(`Information cutoff must be one exact UTC second in cut_off_time and as_of_date: ${id}`);
      const forbidden = ["resolution_date", "resolution_result", "numeric_result", "answer", "numeric_answer", "truth", "ground_truth", "actual_value", "resolved_at"];
      if (forbidden.some((key) => Object.hasOwn(r, key)))
        throw new Error(`Author-side outcome metadata is forbidden in model input: ${id}`);
      if (!validResolutionDate(resolutionDate) || Date.parse(resolutionDate) <= Date.parse(anchor!) ||
          (grade.resolution_result !== 0 && grade.resolution_result !== 1))
        throw new Error(`Actual resolution date/result is missing or not after information cutoff: ${id}`);
      const n = grade.numeric_result;
      const withheld = grade.numeric_result_withheld === true && n === null && r.numeric_target_unit !== null;
      if (!withheld && (r.numeric_target_unit === null ? n !== null :
          !n || !Number.isFinite(n.value) || n.unit !== r.numeric_target_unit))
        throw new Error(`Numeric result is missing, non-finite, or has the wrong unit: ${id}`);
    }
    if (r.response_format === "raven.forecast.v2.1") {
      const exact = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
      if (!r.as_of_date || !exact.test(r.as_of_date) ||
          !r.prediction_cutoff_utc || !exact.test(r.prediction_cutoff_utc) ||
          !Number.isFinite(Date.parse(r.as_of_date)) ||
          !Number.isFinite(Date.parse(r.prediction_cutoff_utc)) ||
          Date.parse(r.prediction_cutoff_utc) <= Date.parse(r.as_of_date) ||
          !r.prompt?.includes(r.as_of_date) || !r.prompt.includes(r.prediction_cutoff_utc) ||
          !(r.numeric_target_unit === null || (typeof r.numeric_target_unit === "string" && r.numeric_target_unit.length > 0)))
        throw new Error(`Invalid exact dates/prompt/numeric target contract: ${id}`);
    }
    // A row missing any of these must not be skipped quietly: the size of the question set is
    // the denominator of every later statistic, and losing a few questions unnoticed is far
    // more dangerous than failing outright.
    if (!id || !text || !anchor || !resolutionDate)
      throw new Error(`${basename(path)} line ${i + 1} is missing the id, question text, anchor or deadline`);
    if (truth !== 0 && truth !== 1)
      throw new Error(`${basename(path)} line ${i + 1}: truth is not 0 or 1: ${String(truth)}`);
    questions.push({
      question_id: id,
      question_text: text,
      resolution_criteria: (r.resolution_criteria ?? r.criteria ?? "").trim(),
      resolution_date: resolutionDate,
      as_of_date: anchor,
      ...(r.response_format === "raven.forecast.v2.1" ? {
        forecast_prompt: r.prompt,
        prediction_cutoff_utc: r.prediction_cutoff_utc,
        response_format: r.response_format,
        numeric_target_unit: r.numeric_target_unit,
      } : {}),
      ground_truth: truth,
      // Leakage field, always null — the pool has the market price at the anchor, which must never reach model input
      market_price_at_freeze: null,
      category: r.source_feed ?? "question-pool",
      difficulty_level: "unlabelled",
      source: r.source_feed ?? "question-pool",
      language: "en",
      difficulty: "unlabelled",
      domain: r.source_feed ?? "question-pool",
      archetype: "unlabelled",
    });
  }
  if (gradingPath && (grades.size !== seen.size || [...grades.keys()].some((id) => !seen.has(id))))
    throw new Error("Separate grading key IDs do not exactly match question IDs");
  // Changing only a grading key must not reuse scores from a different dataset version.
  const sha = createHash("sha256").update(raw + (gradingPath ? "\nGRADING\n" + gradingRaw : "")).digest("hex");
  return {
    questions,
    identity: {
      question_set_id: `question-pool:${basename(path).replace(/\.jsonl$/, "")}@${sha.slice(0, 12)}`,
      family: "question-pool",
      file: basename(path),
      file_sha256: createHash("sha256").update(raw).digest("hex"),
      ...(gradingPath ? { grading_file_sha256: createHash("sha256").update(gradingRaw).digest("hex") } : {}),
      rows_in_file: lines.length,
      rows_loaded: questions.length,
    },
  };
}
