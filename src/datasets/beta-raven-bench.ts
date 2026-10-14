/**
 * The beta-raven-bench question set, embedded in-tree under vendor/.
 *
 * It used to be a git submodule pointing at an upstream beta-raven-bench repository. That one is
 * now archived and this copy is the maintained one, so the files are tracked here directly:
 * there is no pointer to bump and no `--recurse-submodules` to forget.
 *
 * What is in the tree is the agent view — the questions, their anchors and their metadata —
 * plus `answers/`, which holds the answer key as ciphertext only (AES-256-CBC, passphrase
 * held out of band). Cleartext labels are never tracked: the upstream .gitignore that came
 * with these files still excludes `answers/*.jsonl`, `*labels_sealed*` and every `private/`
 * subtree under `data/`, and it still applies here.
 *
 * So the rule the loader enforces is not "no answers in the checkout" — the ciphertext is in
 * the checkout, inert without the passphrase. The rule is that cleartext is read only from
 * BETA_RAVEN_LABELS, a path outside this repository. That is what keeps a future glob over
 * the data directory from finding something it can feed to a model.
 *
 * The upstream policy file states the retrieval rules this benchmark is built to satisfy:
 * `retrieval_mode: frozen_corpus_only`, `deny_live_internet: true`, and
 * `enforce_document_crawl_time_lte_task_forecast_anchor: true`. That last one is the same
 * invariant our corpus enforces in SQL, and `corpus:isolation` is the test for it.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Read through getEnvKey, not process.env: every other key in this project comes from .env
// that way, and a path set in .env but read from process.env would silently yield no labels.
import { getEnvKey } from "../llm/load-env.js";
import { join } from "node:path";
import { PKG_ROOT } from "../paths.js";
import type { Question } from "../types.js";

const ROOT = join(
  PKG_ROOT,
  "vendor",
  "beta-raven-bench",
  "data",
  "polymarket-march-2026",
);

export type BetaRavenSplit = "selected_300" | "candidates_600";

interface DatasetManifest {
  schema_version?: string;
  selector_version?: string;
  generated_at?: string;
}

/** Stable, human-readable identity for the maintained question set checked into this repo. */
export function betaRavenQuestionSetIdentity(split: BetaRavenSplit) {
  const manifestPath = join(ROOT, "manifest.json");
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as DatasetManifest;
  const selectorVersion = manifest.selector_version?.trim() || "unknown";
  const compactSplit = split.replace(/_/g, "");
  return {
    question_set_id: `beta-raven-pm-202603-${compactSplit}@${selectorVersion}`,
    family: "beta-raven-bench",
    collection: "polymarket-march-2026",
    split,
    selector_version: selectorVersion,
    generated_at_utc: manifest.generated_at ?? null,
    manifest_schema_version: manifest.schema_version ?? null,
    manifest_sha256: createHash("sha256").update(raw).digest("hex"),
  } as const;
}

interface AgentQuestion {
  id: string;
  prompt: string;
  en_title: string;
  end_time: string;
  forecast_anchor: string;
  forecast_difficulty: string;
  domain: string;
  temporal_archetype: string;
  level: number;
  task_type: string;
  options: { key: string; text: string }[];
}

export interface BetaRavenQuestion extends Question {
  difficulty: string;
  domain: string;
  archetype: string;
}

/**
 * A line of the sealed answer key.
 *
 * `ground_truth` is the winning OPTION KEY ("A" / "B"), not the word "Yes" — it has to be
 * looked up against that question's own options, because key order is per question.
 * The other fields are the upstream's own audit trail (which market settled it, when, and
 * whether the two Polymarket endpoints agreed); `clob_verification.status` is read so a
 * question the upstream could not verify does not silently become a scored data point.
 */
interface SealedLabel {
  id: string;
  ground_truth?: string;
  final_resolution_state?: string;
  clob_verification?: { status?: string; winner_match?: boolean };
}

function optionToOutcome(
  v: string | undefined,
  options: { key: string; text: string }[],
): 0 | 1 | null {
  if (!v) return null;
  const s = String(v).trim();
  const byKey = options.find((o) => o.key.toLowerCase() === s.toLowerCase());
  const byText = options.find((o) => o.text.toLowerCase() === s.toLowerCase());
  const text = (byKey ?? byText)?.text?.toLowerCase() ?? s.toLowerCase();
  if (text === "yes" || text === "true" || text === "1") return 1;
  if (text === "no" || text === "false" || text === "0") return 0;
  return null;
}

/**
 * @param split which agent view to load
 * @param labelsPath sealed labels; defaults to $BETA_RAVEN_LABELS. Questions whose label is
 *   missing are dropped rather than defaulted — an unlabelled question scored against a
 *   guessed outcome is worse than one question fewer.
 */
/**
 * Drop the upstream prompt's multiple-choice tail.
 *
 * The question text ends with "A. Yes B. No / Return the single best choice, A or B." — the
 * upstream ships these as `single_choice` tasks. We ask for a probability instead, so the
 * model receives two contradictory instructions and has to spend reasoning resolving them:
 * one transcript shows it working through "Need choose A/B? ... But also final line output
 * probability in asterisks." It resolved in our favour every time we checked, but that is
 * luck, not design, and another model need not.
 *
 * Only the tail is removed; everything above it is the resolution criteria, which is the part
 * that defines what counts as Yes and must reach the model intact.
 */
export function stripMultipleChoice(prompt: string): string {
  return prompt
    .replace(/\s*For this binary task, Yes means[\s\S]*?$/i, "")
    .replace(/\s*A\.\s*Yes\s*B\.\s*No\s*$/i, "")
    .replace(/\s*Return the single best choice[^.]*\.\s*$/i, "")
    .trim();
}

export function loadBetaRaven(
  split: BetaRavenSplit = "selected_300",
  labelsPath = getEnvKey("BETA_RAVEN_LABELS"),
): BetaRavenQuestion[] {
  const qPath = join(ROOT, "agent_view", split, "questions.json");
  if (!existsSync(qPath)) {
    throw new Error(
      `beta-raven-bench questions not found at ${qPath}\n` +
        `  These are tracked in this repository under vendor/ — a missing file means the\n` +
        `  checkout is incomplete, not that a submodule needs initialising.`,
    );
  }
  const raw = JSON.parse(readFileSync(qPath, "utf8")) as AgentQuestion[];

  // An answer key is required. Without it every question would load with a null outcome and
  // the run would score against nothing — the earlier version dropped all 300 questions
  // silently, which looked like an empty question set rather than a missing file.
  if (!labelsPath) {
    throw new Error(
      "BETA_RAVEN_LABELS is not set — it must point at the sealed answer key.\n" +
        "  export BETA_RAVEN_LABELS=/path/to/labels_sealed.jsonl",
    );
  }
  if (!existsSync(labelsPath)) {
    throw new Error(
      `BETA_RAVEN_LABELS points at a file that does not exist: ${labelsPath}`,
    );
  }

  const labels = new Map<string, 0 | 1>();
  {
    for (const line of readFileSync(labelsPath!, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const l = JSON.parse(line) as SealedLabel;
        const q = raw.find((r) => r.id === l.id);
        // Drop anything the upstream itself could not verify rather than scoring against it.
        if (
          l.clob_verification?.status &&
          l.clob_verification.status !== "verified"
        )
          continue;
        const o = optionToOutcome(l.ground_truth, q?.options ?? []);
        if (q && o != null) labels.set(l.id, o);
      } catch {
        // A malformed line loses one question, which the count below makes visible.
      }
    }
  }

  const out: BetaRavenQuestion[] = [];
  for (const q of raw) {
    // Binary only: the scorer emits a single P(yes), so a multi-way task has no place to go.
    const yes = q.options.find((o) => o.text.toLowerCase() === "yes");
    const no = q.options.find((o) => o.text.toLowerCase() === "no");
    if (!yes || !no || q.options.length !== 2) continue;
    const gt = labels.get(q.id);
    // Unlabelled or unverifiable questions are dropped; the caller sees the count.
    if (gt == null) continue;
    out.push({
      question_id: `braven::${q.id}`,
      question_text: q.en_title,
      // The upstream prompt already states the cutoff; it is the resolution text here because
      // it is what defines what counts as Yes.
      resolution_criteria: stripMultipleChoice(q.prompt),
      as_of_date: q.forecast_anchor,
      resolution_date: q.end_time,
      ground_truth: gt,
      // Null, not the market price. The project rule is that the public prediction pipeline
      // never reads a market price, and the upstream information policy blocks
      // `market_odds_or_prices` for the same reason: a market price is other forecasters'
      // answer, so scoring against it measures agreement rather than forecasting.
      market_price_at_freeze: null,
      category: q.domain,
      difficulty_level: q.forecast_difficulty,
      source: "beta-raven-bench",
      language: "en",
      difficulty: q.forecast_difficulty,
      domain: q.domain,
      archetype: q.temporal_archetype,
    });
  }
  return out;
}

/** Question counts by split, for a run banner that shows what was actually loaded. */
export function betaRavenSummary(qs: BetaRavenQuestion[]): string {
  const by = (f: (q: BetaRavenQuestion) => string) => {
    const m = new Map<string, number>();
    for (const q of qs) m.set(f(q), (m.get(f(q)) ?? 0) + 1);
    return [...m]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
  };
  return `${qs.length} questions · difficulty ${by((q) => q.difficulty)} · domain ${by((q) => q.domain)}`;
}
