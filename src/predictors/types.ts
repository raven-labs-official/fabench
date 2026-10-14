import type { Question, Prediction } from "../types.js";
import type { BudgetTier, RetrievalEnv } from "../../vendor/retrieval-infra/src/predictors/types.js";
export {
  BudgetTier,
  NullRetrievalEnv,
  type RetrievalEnv,
  type RetrievalResult,
  type SearchHint,
} from "../../vendor/retrieval-infra/src/predictors/types.js";

/** Benchmark predictors use the benchmark's question and prediction schema. */
export interface Predictor {
  readonly id: string;
  predict(question: Question, env: RetrievalEnv, budget: BudgetTier): Promise<Prediction>;
}
