/**
 * Question files for tests. `fixtures/` holds four made-up questions in the exported format
 * (model-facing file plus separate grading key) and is part of every checkout. The formal-232
 * preset and its question files exist only in the team checkout; a test that admits runs under
 * that preset, which is the team default, passes `{ skip: needsFormalSet }`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPreset } from "../experiments/params/resolve.js";
import { PKG_ROOT } from "../paths.js";

export const SYNTHETIC_QUESTIONS = join(PKG_ROOT, "src/datasets/fixtures/synthetic-model-test.jsonl");
export const SYNTHETIC_GRADING = join(PKG_ROOT, "src/datasets/fixtures/synthetic-grading-key.jsonl");

const FORMAL_QUESTIONS = join(PKG_ROOT, "question-making/curated/raven_model_test.jsonl");
const FORMAL_FILES = [join(PKG_ROOT, "config/presets/formal-232.json"), FORMAL_QUESTIONS,
  join(PKG_ROOT, "question-making/curated/raven_grading_key.jsonl")];

export const needsFormalSet: string | false = FORMAL_FILES.every((file) => existsSync(file)) && defaultPreset() === "formal-232"
  ? false : "needs the formal-232 preset as the default and its question files (team checkout only)";

/** Question ids of the formal set, in file order. */
export function formalQuestionIds(): string[] {
  return readFileSync(FORMAL_QUESTIONS, "utf8").trim().split("\n").map((line) => String(JSON.parse(line).id));
}
