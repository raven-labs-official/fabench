// Predictor + RetrievalEnv + BudgetTier interfaces.

import type { Question, Prediction } from "../types.js";

// ── BudgetTier ──

export const BudgetTier = {
  Low: "le_0_10",
  Mid: "le_0_50",
  Unlimited: "unlimited",
} as const;
export type BudgetTier = (typeof BudgetTier)[keyof typeof BudgetTier];

// A per-run dollar cap was defined here (budgetCapUsd / CostMeter / createCostMeter) and
// never wired to anything: BudgetTier survives as a label recorded with each prediction,
// but no code ever compared spend against a cap. Removed rather than left looking enforced.

// ── RetrievalEnv ──

export interface RetrievalResult {
  url: string;
  title: string;
  snippet: string;
  content_timestamp_utc: string;
  body?: string;
}

/**
 * Optional extra context about the question behind a query.
 *
 * Plain `search(query, asOf)` is all a lexical index needs, but a query-rewriting
 * wrapper writes better queries when it can see the resolution criteria — that is
 * where the specific resolvable clause lives, while the question title usually names
 * only the most famous entity. Every field is optional and every backend may ignore
 * it, so adding this does not change what an existing env has to implement.
 */
export interface SearchHint {
  resolutionCriteria?: string;
}

export interface RetrievalEnv {
  readonly mode: "past" | "live";
  search(query: string, asOf: string, hint?: SearchHint): Promise<RetrievalResult[]>;
  validateCitations(
    urls: readonly string[],
    asOf: string,
  ): Promise<{ url: string; valid: boolean; content_timestamp_utc: string | null }[]>;
}

export const NullRetrievalEnv: RetrievalEnv = {
  mode: "past",
  async search() {
    return [];
  },
  async validateCitations(urls) {
    return urls.map((url) => ({ url, valid: true, content_timestamp_utc: null }));
  },
};

// ── Predictor ──

export interface Predictor {
  readonly id: string;
  predict(question: Question, env: RetrievalEnv, budget: BudgetTier): Promise<Prediction>;
}
