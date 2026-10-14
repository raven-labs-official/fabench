/** A caller can correct these arguments; the retrieval service remains usable. */
export class RetrievalInputError extends Error {
  readonly name = 'RetrievalInputError';
  readonly code = 'invalid_browse_arguments';
}

export function isRetrievalInputError(error: unknown): error is RetrievalInputError {
  return error instanceof RetrievalInputError;
}
