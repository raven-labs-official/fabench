import { readFileSync } from "node:fs";
import {
  betaRavenSummary,
  loadBetaRaven,
} from "../../datasets/beta-raven-bench.js";
import { loadQuestionPool } from "../../datasets/question-pool.js";
import { sha256 } from "../../tracing/trace-archive.js";
import type { Question } from "../../types.js";
import { loadAdmissionReceipt } from "../environment-check.js";
import { isChinaFiltered } from "../question-filter.js";
import { normalizeQuestionId } from "../question-selection.js";

import type { ForecastOptions } from "./options.js";

export interface TopicInfo {
  topic: string;
  evidence_type: string;
  resolvable_pre_anchor: string;
}

/**
 * Take questions evenly across topics rather than off the top of the list.
 *
 * Round-robin over topics ordered by size, so a 20-question sample of a set that is 28%
 * Middle East still reaches monetary policy, elections and crypto.
 */
function stratify(
  questions: Question[],
  topics: Record<string, TopicInfo>,
  n: number,
): Question[] {
  if (n <= 0 || n >= questions.length) return questions;
  const buckets = new Map<string, Question[]>();
  for (const q of questions) {
    const t = topics[q.question_id]?.topic ?? "unknown";
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t)!.push(q);
  }
  const ordered = [...buckets.values()].sort((a, b) => b.length - a.length);
  const out: Question[] = [];
  for (let round = 0; out.length < n; round++) {
    let advanced = false;
    for (const b of ordered) {
      if (round < b.length) {
        out.push(b[round]!);
        advanced = true;
        if (out.length >= n) break;
      }
    }
    if (!advanced) break;
  }
  return out;
}

/**
 * Load the dataset, apply the requested filter, and select the question sample.
 *
 * `launch.offline` declares a caller that never calls a model (tests, previews built in code),
 * so the shared-server direct-launch guard does not apply to it; `currentRelease` lets a test
 * stand in for the shared release path.
 */
export function loadForecastQuestions(
  options: ForecastOptions,
  launch: { offline?: boolean; currentRelease?: string } = {},
) {
  const { n } = options;
  const questionsFile = options.questionsFile;
  const gradingFile = options.gradingFile;
  const environmentAdmission = loadAdmissionReceipt(process.cwd(), {
    raw: options.parameters.raw,
    conditionPreview: Boolean(options.conditionPreviewFile),
    ...launch,
  });
  if (gradingFile && !questionsFile)
    throw new Error("--grading-file requires --questions-file");
  const questionPool = questionsFile
    ? loadQuestionPool(questionsFile, gradingFile || undefined)
    : null;
  if (questionPool) {
    console.log(
      `    question set ${questionPool.identity.question_set_id}` +
        ` (${questionPool.identity.rows_loaded} questions, file ${questionPool.identity.file})`,
    );
  }
  const qs = questionPool
    ? questionPool.questions
    : loadBetaRaven("selected_300");
  if (!qs.length) {
    console.error(
      `beta-raven-bench: 0 labelled questions.\n` +
        `  The questions ship in this repository under vendor/beta-raven-bench.\n` +
        `  BETA_RAVEN_LABELS=/path/labels.jsonl supplies the answers`,
    );
    process.exit(2);
  }
  console.log(`    ${betaRavenSummary(qs)}`);
  // Report how the political-content filter affects the selected question set.
  const includeChinaFilteredArg = options.includeChinaFilteredArg;
  if (!["0", "1"].includes(includeChinaFilteredArg))
    throw new Error(`--include-china-filtered accepts only 0 or 1`);
  const includeChinaFiltered = includeChinaFilteredArg === "1";
  const excluded = qs.filter(isChinaFiltered);
  const all: Question[] = includeChinaFiltered
    ? qs
    : qs.filter((q) => !isChinaFiltered(q));
  if (excluded.length) {
    console.log(
      includeChinaFiltered
        ? `    ⚠️  all questions requested explicitly: includes ${excluded.length} that may trigger the content_filter of Chinese models`
        : `    excluded ${excluded.length} China-related political questions (the kind Chinese models refuse through content_filter; economics and technology questions are kept)`,
    );
  }
  // Topic comes from the question set itself; beta-raven-bench labels every question with a
  // domain, so nothing has to be inferred or maintained alongside.
  const topics: Record<string, TopicInfo> = Object.fromEntries(
    qs.map((q) => [
      q.question_id,
      {
        topic: q.domain,
        evidence_type: q.archetype,
        resolvable_pre_anchor: q.difficulty,
      },
    ]),
  );
  // --ids / --ids-file win over the stratified first-N sample: when either is given the
  // run is restricted to exactly those question ids and --n is ignored for selection, so a
  // partially-completed run resumes on only its unfinished questions. Neither passed → the
  // original stratified behaviour is unchanged.
  const idSelection = options.idSelection;
  let questions: Question[];
  if (idSelection) {
    // Loaded ids are `braven::<uuid>` (see loadBetaRaven); a caller may paste either that
    // or the bare uuid, so strip the prefix on both sides before comparing.
    const want = new Set(idSelection.map(normalizeQuestionId));
    questions = all.filter((q) => want.has(normalizeQuestionId(q.question_id)));
    // Name any requested id that matched nothing loaded — a typo, or a question dropped by
    // the China filter or for want of a verified label — so a short run is not mistaken for
    // a complete one. Counted out loud, per the project rule that every gate has a counter.
    const found = new Set(questions.map((q) => normalizeQuestionId(q.question_id)));
    const missing = [...want].filter((id) => !found.has(id));
    if (missing.length)
      console.log(
        `    \u26a0\ufe0f  ${missing.length}/${want.size} --ids matched no loaded question: ` +
          `${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`,
      );
    if (!questions.length) {
      console.error(
        `--ids/--ids-file matched 0 loaded questions — nothing to run. Check that the ids are correct and not removed by the China filter or for lack of a verified label.`,
      );
      process.exit(2);
    }
    console.log(`    --ids: selected ${questions.length} questions (stratified sampling and --n skipped)`);
  } else {
    questions = stratify(all, topics, n);
  }

  return {
    questionsFile,
    gradingFile,
    environmentAdmission,
    questionPool,
    questions,
    topics,
    includeChinaFiltered,
    excluded,
  };
}

/** Read the fixed evidence packet used by the provided arm. */
export function loadProvidedEvidence(evidenceFile: string) {
  const providedEvidence = new Map<string, string>();
  let evidenceSha = "";
  let evidenceQuestionCount = 0;
  if (evidenceFile) {
    const rawEvidence = readFileSync(evidenceFile, "utf8");
    evidenceSha = sha256(rawEvidence);
    for (const row of JSON.parse(rawEvidence) as Array<{
      id: string;
      needed_at_anchor?: Array<{ claim: string }>;
    }>) {
      const items = (row.needed_at_anchor ?? [])
        .map((x) => x.claim)
        .filter(Boolean);
      if (!items.length) continue;
      const text = items.map((c, i) => `${i + 1}. ${c}`).join("\n\n");
      // Indexed under both id spellings. The benchmark's question ids carry a `braven::`
      // prefix and the analysis tooling that produces these packets writes bare UUIDs, so a
      // packet built off an analysis export would otherwise match nothing at all — and the
      // guard downstream would refuse every question, one at a time, with a message about
      // the id list rather than about the prefix.
      evidenceQuestionCount++;
      providedEvidence.set(row.id, text);
      providedEvidence.set(row.id.replace(/^braven::/, ""), text);
      if (!row.id.startsWith("braven::"))
        providedEvidence.set(`braven::${row.id}`, text);
    }
  }
  return { providedEvidence, evidenceSha, evidenceQuestionCount };
}
