import type { LlmClient, LlmRequest } from "../llm/benchmark-client.js";

/** One FIFO gate shared by all conversations and native sessions of a forecasting client. */
class ModelGate {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  private async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        this.waiting.splice(this.waiting.indexOf(grant), 1);
        reject(signal!.reason);
      };
      this.waiting.push(grant);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  async complete(client: LlmClient, request: LlmRequest) {
    const started = performance.now();
    await this.acquire(request.signal);
    try {
      request.signal?.throwIfAborted();
      request.onTrace?.({
        type: "local_model_admitted",
        data: { concurrency: this.limit, waited_ms: performance.now() - started },
      });
      return await client.complete(request);
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export function limitModelConcurrency(client: LlmClient, limit?: number): LlmClient {
  if (limit === undefined) return client;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("--llm-concurrency must be a positive safe integer");
  const gate = new ModelGate(limit);
  function wrap(client: LlmClient): LlmClient {
    return {
      id: client.id,
      traceMetadata: client.traceMetadata,
      complete: (request) => gate.complete(client, request),
      ...(client.reasoningConfiguration
        ? { reasoningConfiguration: client.reasoningConfiguration.bind(client) }
        : {}),
      ...(client.startConversation
        ? { startConversation: () => wrap(client.startConversation!()) }
        : {}),
      ...(client.openForecast
        ? { openForecast: () => {
            const session = client.openForecast!();
            return { ...wrap(session), close: () => session.close() };
          } }
        : {}),
    };
  }
  return wrap(client);
}
