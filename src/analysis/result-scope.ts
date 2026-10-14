export type ResultScope = "benchmark" | "smoke";

/**
 * Small-sample runs remain visible in answer tables and summaries, but they are
 * classified as smoke so they cannot displace a publishable benchmark condition.
 */
export function classifyResultScope(
  expectedQuestions: number,
  minimumBenchmarkQuestions: number,
): ResultScope {
  if (!Number.isInteger(expectedQuestions) || expectedQuestions < 1) {
    throw new Error("expectedQuestions must be a positive integer");
  }
  if (!Number.isInteger(minimumBenchmarkQuestions) || minimumBenchmarkQuestions < 1) {
    throw new Error("minimumBenchmarkQuestions must be a positive integer");
  }
  return expectedQuestions < minimumBenchmarkQuestions ? "smoke" : "benchmark";
}
