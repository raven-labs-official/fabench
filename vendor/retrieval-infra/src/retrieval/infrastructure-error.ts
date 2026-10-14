/**
 * A shared retrieval dependency is unavailable, so continuing the affected arm would spend
 * money on forecasts that did not receive the evidence treatment named by the experiment.
 *
 * This is deliberately narrower than an empty search result or an unreachable article. Those
 * are normal properties of the web. The circuit breaker only reacts to failures of the search,
 * dating, or filtering infrastructure shared by many cells.
 */
export class RetrievalInfrastructureError extends Error {
  readonly name = "RetrievalInfrastructureError";

  constructor(
    readonly component: "search-provider" | "page-dater" | "leak-filter" | "frozen-index",
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function isRetrievalInfrastructureError(
  error: unknown,
): error is RetrievalInfrastructureError {
  return error instanceof RetrievalInfrastructureError;
}
