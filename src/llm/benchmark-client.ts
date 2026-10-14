export * from "./client.js";
import type { LlmClient as InfraLlmClient } from "../../vendor/retrieval-infra/src/llm/client.js";
/** A benchmark transport may hold a native per-question session between tool results. */
export interface LlmClient extends InfraLlmClient {
  openForecast?(): LlmClient & { close(): void };
}
