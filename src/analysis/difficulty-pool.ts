export interface DifficultyPoolAnswer {
  result_scope: "benchmark" | "smoke";
  publication_status: string;
  raw_brier: number;
}

/**
 * Empirical question difficulty intentionally includes every successful Smoke
 * answer alongside primary benchmark answers. Formal leaderboard and paired
 * significance calculations continue to use primary answers only.
 */
export function isEmpiricalDifficultyAnswer(answer: DifficultyPoolAnswer): boolean {
  return answer.publication_status === "primary" || answer.result_scope === "smoke";
}

