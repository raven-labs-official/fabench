export interface Question {
  question_id: string;
  question_text: string;
  resolution_criteria: string;
  /** Author-side actual result date for raven.question.v3; legacy pools used a target deadline. Never use as a retrieval cutoff when as_of_date is present. */
  resolution_date: string;
  /**
   * The anchor: the day the forecast is made from, and the only correct retrieval cutoff.
   * Retrieving anything crawled after it means the model is reading the future rather than
   * forecasting it. The agentic predictor requires this field and never falls back to the result date.
   */
  as_of_date?: string;
  /** Opt-in reviewed question prompt. Never contains author-side truth or post-as-of evidence. */
  forecast_prompt?: string;
  prediction_cutoff_utc?: string;
  response_format?: "raven.forecast.v2.1";
  numeric_target_unit?: string | null;
  ground_truth: number | null;
  market_price_at_freeze: number | null;
  category: string;
  difficulty_level: string;
  source: string;
  language: string;
}

export interface Prediction {
  question_id: string;
  probabilities: number[];
  numeric_forecast?: { value: number; unit: string } | null;
  ci_low?: number | null;
  ci_high?: number | null;
  rationale_md: string;
  sources: { title: string; url: string; retrieved_at_utc: string }[];
  predictor_id: string;
  budget_tier: string;
  cost_usd: number;
  /**
   * Token usage across every model call this prediction took (a tool loop is many calls).
   * Optional because not every predictor's backend reports usage; absent means unreported,
   * not zero — a 0 here would silently understate cost the same way a defaulted 0.5 cell
   * silently corrupts a results table.
   */
  input_tokens?: number;
  output_tokens?: number;
  predicted_at_utc: string;
}
