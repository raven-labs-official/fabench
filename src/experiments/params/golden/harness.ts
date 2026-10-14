/**
 * Shared setup for the golden identity tests: build condition objects exactly as the runner
 * does, from options produced by the frozen 733fec5 argument handling or by the resolver.
 * Nothing here calls a model, a search provider or a shared-server resource.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFrozenIndex } from "../../../../vendor/retrieval-infra/src/corpus/frozen-index.js";
import { CorpusStore } from "../../../../vendor/retrieval-infra/src/corpus/store.js";
import { WikipediaCache, wikiEndpoint } from "../../../../vendor/retrieval-infra/src/corpus/wikipedia-cache.js";
import type { LlmClient } from "../../../llm/benchmark-client.js";
import { getEnvKey } from "../../../llm/load-env.js";
import { readForecastArms, type ForecastOptions } from "../../forecast/options.js";
import { loadForecastQuestions, loadProvidedEvidence } from "../../forecast/questions.js";
import { createForecastRetrieval } from "../../forecast/retrieval.js";
import { buildForecastRunConfig } from "../../forecast/run-config.js";
import { legacyReadForecastOptions } from "./legacy-733fec5.js";
import { projectEnv } from "../../../env-names.js";

/** Placeholder credentials so clients can be constructed; restored afterwards. No request is sent. */
export function placeholderCredentials(): () => void {
  const set: string[] = [];
  for (const name of ["DEEPSEEK_API_KEY", "SERPER_API_KEY"])
    if (!getEnvKey(name)) { process.env[name] = "golden-identity-placeholder"; set.push(name); }
  if (projectEnv("FABENCH_SHARED_LIFECYCLE") === "1") throw new Error("golden tests must not run inside a shared lifecycle");
  return () => { for (const name of set) delete process.env[name]; };
}

/** A complete historical FTS index whose anchor matches the fixture questions. */
export async function frozenIndexFixture(dir: string, anchor: string): Promise<string> {
  const source = join(dir, "source.db"), index = join(dir, "frozen-index.db");
  const store = new CorpusStore(source, "concept", "write");
  store.ingest([{ url: "https://example.test/orion", title: "Orion budget", body: "Orion budget is 25 billion.",
    crawlDate: new Date(Date.parse(anchor) - 30 * 86_400_000).toISOString() }]);
  store.close();
  await buildFrozenIndex(source, index, anchor, { minimumFreeBytes: 0 });
  return index;
}

/** A one-page Wiki cache and its manifest at the anchor. */
export function wikiFixture(dir: string, anchor: string): { cache: string; manifest: string } {
  const cachePath = join(dir, "wiki-cache.sqlite"), manifestPath = join(dir, "wiki-manifest.json");
  const cache = new WikipediaCache(cachePath), target = { host: "https://en.wikipedia.org", title: "Orion" };
  const body = "'''Orion''' telescope historical evidence.";
  const raw = JSON.stringify({ query: { pages: [{ pageid: 1, revisions: [{ revid: 42, timestamp: new Date(Date.parse(anchor) - 86_400_000).toISOString(),
    sha1: createHash("sha1").update(body).digest("hex"), slots: { main: { contentmodel: "wikitext", content: body } } }] }] } });
  cache.importCapture(target, anchor, raw, new Date(Date.parse(anchor) + 60 * 86_400_000).toISOString(), wikiEndpoint(target, anchor));
  writeFileSync(manifestPath, JSON.stringify(cache.manifest(anchor)));
  cache.close();
  return { cache: cachePath, manifest: manifestPath };
}

/** A small question bank with a separate grading file at one anchor. */
export function questionFixture(dir: string, anchor: string, count = 3): { questions: string; grading: string } {
  mkdirSync(dir, { recursive: true });
  const questions = join(dir, "questions.jsonl"), grading = join(dir, "grading.jsonl");
  const ids = Array.from({ length: count }, (_, i) => `G${i + 1}`);
  writeFileSync(questions, ids.map((id) => JSON.stringify({ id, question: `Will event ${id} happen?`, anchor,
    resolution_date: new Date(Date.parse(anchor) + 30 * 86_400_000).toISOString(), source_feed: "test" })).join("\n") + "\n");
  writeFileSync(grading, ids.map((id, i) => JSON.stringify({ id, resolution_result: i % 2 })).join("\n") + "\n");
  return { questions, grading };
}

export const fixtureClient: LlmClient = {
  id: "fixture:model",
  complete: async () => { throw new Error("golden identity tests must not call a model"); },
};

/** Options from the 733fec5 parser, shaped like current options (no parameter record). */
/** The same arguments with --settings written as --compare, the only spelling 733fec5 knows. */
export function formerSpelling(args: readonly string[]): string[] {
  return args.map((arg) => (arg === "--settings" ? "--compare" : arg));
}

export function legacyOptions(args: string[]): ForecastOptions {
  return { ...legacyReadForecastOptions(args), parameters: { raw: args, summary: () => null } } as unknown as ForecastOptions;
}

/** The condition objects the runner would register for these options. */
export function conditionsFor(options: ForecastOptions) {
  const dataset = loadForecastQuestions(options, { offline: true });
  const evidence = loadProvidedEvidence(options.evidenceFile);
  const arms = readForecastArms(options);
  const retrieval = createForecastRetrieval({ options, arms, client: fixtureClient, questions: dataset.questions,
    evidenceFile: options.evidenceFile, providedEvidence: evidence.providedEvidence });
  try {
    return buildForecastRunConfig({ options, arms, retrieval, dataset, evidence, evidenceFile: options.evidenceFile,
      client: fixtureClient }).conditions;
  } finally {
    retrieval.close();
  }
}
