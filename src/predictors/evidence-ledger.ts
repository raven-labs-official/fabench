/**
 * The structured evidence ledger: the model's reasoning made observable, not constrained.
 *
 * WHY THIS EXISTS. The v1 prompt already tells the model to start from a named base rate and to
 * keep each adjustment inside the strength of its evidence. It complies with the FORM and
 * ignores the ARITHMETIC: across 982 measured cells the largest single retrieval-induced move
 * was 0.97 and 47 cells moved more than 0.50, which three stacked "strong" items cannot reach.
 * But that diagnosis rests on reading prose after the fact. The ledger asks for the same
 * reasoning as DATA — a base rate with its source, the shape of the question, and each piece of
 * evidence with a type and a direction — so the gap between what the model says it did and what
 * it did becomes a number rather than an impression.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not set the probability, and the prompt names no
 * point values or caps at all. An earlier draft did both: the model emitted only classified
 * entries and `computeProbability` produced the forecast from a table of per-type caps. That
 * was wrong twice over. The caps were derived from the same 205 harmful cells the experiment
 * would then be scored on, which is the circular after-the-fact weighting the team had already
 * rejected elsewhere; and a score produced by our arithmetic measures our table, not the
 * model, so it generalises to nothing. Telling the model the caps would also anchor the very
 * classifications we want to observe honestly.
 *
 * So the model states its own probability and that is what is scored. `computeProbability`
 * remains, but only as a SHADOW: given a recorded ledger it says what some points table would
 * have produced. Because the ledger is archived, any table can be evaluated offline afterwards,
 * on held-out questions, without spending another run — which is the only honest way to choose
 * one.
 *
 * The numbers in POINTS below are therefore a hypothesis awaiting that offline test, not a rule
 * anything currently obeys.
 */

/** What kind of thing the evidence IS — which is what decides how far it may move a forecast. */
export type EvidenceType =
  /** The settlement condition is already satisfied, or official data settles it. */
  | "already_happened"
  /** A specific event confirmed by mainstream reporting, but not itself settling. */
  | "confirmed_event"
  /** Named expert analysis or a statistical model. */
  | "expert_or_model"
  /** Tension, intent, rhetoric, a recent trend — the world "looking like" the outcome. */
  | "narrative"
  /** "It has not happened as of the anchor." Absence, not evidence — see the cap. */
  | "absence";

export interface LedgerEntry {
  claim: string;
  evidence_type: EvidenceType;
  /** "+" raises the probability of Yes, "-" lowers it. */
  direction: "+" | "-";
  /**
   * Only meaningful for `absence`. Absence is evidence against an event ONLY when the event
   * would certainly have been reported by now had it occurred. The model must assert that
   * explicitly; an unasserted absence contributes nothing.
   */
  observation_window_sufficient?: boolean;
}

/**
 * Whether the question asks about a state at one moment or about anything happening across a
 * window. Recorded because the two are answered very differently and the model conflates them:
 * on 18 questions where every arm degraded, the shared error was answering "is this true now"
 * for a question that asked "does this happen at any point in the next N days".
 */
export type QuestionShape = "any_point_in_window" | "state_at_deadline";

export interface Ledger {
  question_shape: QuestionShape | null;
  /** Days from the as-of date to the deadline, as the model reckons it. */
  window_days: number | null;
  base_rate: number;
  base_rate_source: string;
  entries: LedgerEntry[];
  /** The model's own forecast. This is what gets scored. */
  final_probability: number | null;
}

interface TypeRule {
  /** Points a single entry of this type may contribute. */
  perEntry: number;
  /** Ceiling on this type's NET contribution, however many entries it has. */
  netCap: number;
}

export const POINTS: Record<EvidenceType, TypeRule> = {
  already_happened: { perEntry: 20, netCap: Number.POSITIVE_INFINITY },
  confirmed_event: { perEntry: 8, netCap: 25 },
  expert_or_model: { perEntry: 5, netCap: 15 },
  narrative: { perEntry: 3, netCap: 10 },
  absence: { perEntry: 2, netCap: 5 },
};

export const EVIDENCE_TYPES = Object.keys(POINTS) as EvidenceType[];

/** Forecasts of exactly 0 or 1 are never justified and are infinitely penalised by Brier. */
const FLOOR = 0.01;
const CEIL = 0.99;

export interface LedgerComputation {
  probability: number;
  baseRate: number;
  /** Net points contributed by each type AFTER its cap, for the trace. */
  pointsByType: Partial<Record<EvidenceType, number>>;
  totalPoints: number;
  /** Entries whose type was unrecognised: they contribute nothing and are surfaced, not hidden. */
  unknownTypes: string[];
  /** `absence` entries that did not assert a sufficient observation window: contribute nothing. */
  droppedAbsence: number;
  /** Types whose raw sum exceeded the cap — the cap actually bit here. */
  cappedTypes: EvidenceType[];
}

/**
 * SHADOW ONLY — what the ledger would come to under the POINTS table. Never the score.
 *
 * Recorded alongside the model's own probability so the two can be compared offline, and so a
 * points table can be fitted on one set of questions and tested on another. Pure and total:
 * same ledger, same number, no model call.
 *
 * Capping is applied to each type's NET total rather than per entry, because the hypothesised
 * failure mode is a pile of individually-plausible narrative items all pointing the same way.
 */
export function computeProbability(ledger: Ledger): LedgerComputation {
  const raw: Partial<Record<EvidenceType, number>> = {};
  const unknownTypes: string[] = [];
  let droppedAbsence = 0;

  for (const e of ledger.entries ?? []) {
    const type = normaliseType(e.evidence_type);
    if (!type) {
      unknownTypes.push(String(e.evidence_type));
      continue;
    }
    // An absence that cannot argue its own observation window is not evidence. Dropping it is
    // the whole point of the type existing: "no reports yet" was 51 of the 205 harmful cells.
    if (type === "absence" && e.observation_window_sufficient !== true) {
      droppedAbsence++;
      continue;
    }
    const sign = e.direction === "-" ? -1 : 1;
    raw[type] = (raw[type] ?? 0) + sign * POINTS[type].perEntry;
  }

  const pointsByType: Partial<Record<EvidenceType, number>> = {};
  const cappedTypes: EvidenceType[] = [];
  let totalPoints = 0;
  for (const type of EVIDENCE_TYPES) {
    const v = raw[type];
    if (v === undefined) continue;
    const cap = POINTS[type].netCap;
    const capped = Math.max(-cap, Math.min(cap, v));
    if (capped !== v) cappedTypes.push(type);
    pointsByType[type] = capped;
    totalPoints += capped;
  }

  const baseRate = clamp(Number(ledger.base_rate), FLOOR, CEIL);
  // Rounded because the inputs are a decimal and a whole number of points, so 0.05 + 10/100
  // arriving as 0.15000000000000002 is IEEE noise rather than a forecast. Four places is far
  // finer than any decision the number feeds, and it keeps traces and JSON readable.
  const probability = round4(clamp(baseRate + totalPoints / 100, FLOOR, CEIL));
  return { probability, baseRate, pointsByType, totalPoints, unknownTypes, droppedAbsence, cappedTypes };
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(lo, Math.min(hi, v));
}

/** Models write `Already Happened`, `already-happened`, `ALREADY_HAPPENED`. All are the type. */
function normaliseType(t: unknown): EvidenceType | null {
  if (typeof t !== "string") return null;
  const k = t.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (EVIDENCE_TYPES as string[]).includes(k) ? (k as EvidenceType) : null;
}

/**
 * Pull the ledger out of a final answer.
 *
 * Scans for JSON objects from the END of the text, because a model that reconsiders emits the
 * corrected ledger last, and takes the first one that is structurally a ledger. Returns null
 * rather than guessing: the caller records the failure and falls back visibly, since a silent
 * fallback would let format failures masquerade as forecasting failures in the A/B.
 */
export function parseLedger(text: string): Ledger | null {
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const o = parsed as Record<string, unknown>;
    if (typeof o.base_rate !== "number" || !Array.isArray(o.entries)) continue;
    const shape = o.question_shape;
    return {
      question_shape:
        shape === "any_point_in_window" || shape === "state_at_deadline" ? shape : null,
      window_days: typeof o.window_days === "number" ? o.window_days : null,
      final_probability: typeof o.final_probability === "number" ? o.final_probability : null,
      base_rate: o.base_rate,
      base_rate_source: typeof o.base_rate_source === "string" ? o.base_rate_source : "",
      entries: (o.entries as unknown[]).filter(isEntryish).map((e) => {
        const r = e as Record<string, unknown>;
        return {
          claim: typeof r.claim === "string" ? r.claim : "",
          evidence_type: r.evidence_type as EvidenceType,
          direction: r.direction === "-" ? "-" : "+",
          observation_window_sufficient: r.observation_window_sufficient === true,
        };
      }),
    };
  }
  return null;
}

function isEntryish(e: unknown): boolean {
  return !!e && typeof e === "object" && "evidence_type" in (e as object);
}

/**
 * Every balanced `{...}` span in the text, last first. Fenced blocks are unwrapped by the brace
 * scan itself, so ```json fences, bare objects and objects trailing prose all work.
 */
function* jsonCandidates(text: string): Generator<string> {
  const opens: number[] = [];
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") opens.push(i);
    else if (text[i] === "}" && opens.length) {
      const start = opens.pop()!;
      if (opens.length === 0) spans.push([start, i + 1]);
    }
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    const [start, end] = spans[i]!;
    yield text.slice(start, end);
  }
}

/**
 * The prompt block that replaces step 7. It names no point values and no caps: the model gives
 * its own probability, and the classification is only useful as evidence if it was made without
 * knowing what each label would be worth.
 */
export const LEDGER_INSTRUCTIONS = [
  "OUTPUT CONTRACT — THIS REPLACES STEP 7 ABOVE. Steps 1-6 are unchanged.",
  "",
  "Give your forecast as a single JSON object, so that your reasoning can be read as data",
  "rather than as prose. Nothing here changes what you should conclude — the probability is",
  "yours, and only yours. It records how you got there.",
  "",
  "1. THE SHAPE OF THE QUESTION. Say whether it asks about a state at one moment",
  "   (state_at_deadline: 'will X be true on June 30') or about anything happening across a",
  "   span (any_point_in_window: 'will X happen by June 30', 'will X ever reach 6.5%'). Give",
  "   the window in days from the as-of date to the deadline. These are answered differently:",
  "   for a window, the current value is not the answer, because there are many chances for the",
  "   thing to occur and only one of them has to.",
  "",
  "2. THE BASE RATE you started from, and where it came from.",
  "",
  "3. THE EVIDENCE, one entry each, classified by what the evidence IS rather than by how",
  "   convincing you found it:",
  "     already_happened  The settlement condition is already satisfied, or official data",
  "                       settles it. Check it against the resolution boundary you pinned in",
  "                       step 1, clause by clause: a related event that falls outside the",
  "                       criteria is confirmed_event, not already_happened.",
  "     confirmed_event   A specific event confirmed by mainstream reporting, bearing on the",
  "                       outcome without settling it.",
  "     expert_or_model   Named expert analysis or a statistical model.",
  "     narrative         Tension, stated intent, rhetoric, momentum, a recent trend — the",
  "                       world LOOKING like the outcome.",
  "     absence           'It has not happened as of the as-of date.' Set",
  "                       observation_window_sufficient to true only if an occurrence would",
  "                       certainly have been reported by now; the archive ends at the as-of",
  "                       date, so not finding something is often the archive's boundary rather",
  "                       than the world's answer.",
  "   and by direction: '+' raises the probability of Yes, '-' lowers it.",
  "",
  "4. YOUR PROBABILITY. Your own number, in [0,1]. It is what will be scored.",
  "",
  "End your answer with the object and nothing after it:",
  "",
  "```json",
  "{",
  '  "question_shape": "any_point_in_window",',
  '  "window_days": 308,',
  '  "base_rate": 0.08,',
  '  "base_rate_source": "reference class and where the frequency comes from",',
  '  "entries": [',
  '    {"claim": "...", "evidence_type": "already_happened", "direction": "+"},',
  '    {"claim": "...", "evidence_type": "narrative", "direction": "+"},',
  '    {"claim": "...", "evidence_type": "absence", "direction": "-",',
  '     "observation_window_sufficient": false}',
  "  ],",
  '  "final_probability": 0.37',
  "}",
  "```",
  "",
  "An empty entries list is a legitimate answer: it means the base rate stands.",
].join("\n");
