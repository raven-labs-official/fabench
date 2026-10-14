import { readFileSync } from "node:fs";

/**
 * Legacy `raven.concurrency.v1` file keys and the run parameters they set. The layered
 * parameter system (src/experiments/params) reads the file as an override layer after
 * --config files and before the command line.
 */
export const CONCURRENCY_FILE_KEYS = {
  question_concurrency: "conc",
  model_concurrency: "llm_concurrency",
  frozen_workers: "frozen_workers",
  frozen_queue: "frozen_queue",
  candidate_concurrency: "candidate_concurrency",
  review_concurrency: "review_concurrency",
  cleaning_concurrency: "cleaning_concurrency",
  search_concurrency: "search_concurrency",
  fetch_concurrency: "fetch_concurrency",
  reader_concurrency: "reader_concurrency",
  reader_rpm: "reader_rpm",
  page_dispatch_concurrency: "page_dispatch_concurrency",
} as const;

/** Run-local operating limits keyed by run parameter. Unknown keys and bad values fail. */
export function readConcurrencyFile(file: string): Record<string, number> {
  const config: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Concurrency configuration must be a JSON object");
  const { schema, ...limits } = config as Record<string, unknown>;
  if (schema !== "raven.concurrency.v1")
    throw new Error("Expected concurrency schema raven.concurrency.v1");
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(CONCURRENCY_FILE_KEYS, key))
      throw new Error(`Unknown concurrency setting: ${key}`);
    if (!Number.isSafeInteger(value) || Number(value) < 1)
      throw new Error(`${key} must be a positive safe integer`);
    out[CONCURRENCY_FILE_KEYS[key as keyof typeof CONCURRENCY_FILE_KEYS]] = Number(value);
  }
  return out;
}
