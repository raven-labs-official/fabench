import { createHash } from 'node:crypto';
import type { SearchHit } from './store.js';
import { RetrievalInputError } from '../retrieval/input-error.js';

/** Literal entity membership, with capture-time pagination rather than top-k ranking. */
export interface BrowseOptions {
  entity: string;
  /** Inclusive capture start. A date alone means 00:00:00 UTC. */
  since?: string;
  /** Inclusive capture end, capped at asOf. A date alone means end of day UTC. */
  until?: string;
  cursor?: string;
  /** Captures per page, 1–100; default 20. */
  limit?: number;
}
export interface BrowseQuery {
  entity: string;
  terms: string[];
  since: string | null;
  until: string;
  asOf: string;
  order: 'capture-desc-id-desc';
}
export interface BrowsePage {
  /** Each capture is retained, including different versions of the same URL. */
  results: Array<SearchHit & { capturedId: number }>;
  nextCursor: string | null;
  query: BrowseQuery;
}
interface Position { ms: number; id: number }
export interface PreparedBrowse {
  query: BrowseQuery;
  expression: string;
  lowerMs: number;
  upperMs: number;
  limit: number;
  position: Position | null;
  cursorFor(position: Position): string;
}

function timestamp(value: string, label: string, endOfDay = false, exact = false): number {
  if (typeof value !== 'string') throw new RetrievalInputError(`${label} must be a timestamp string`);
  let iso = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  if (dateOnly && !exact) iso += endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) {
    throw new RetrievalInputError(`${label} must be an ISO timestamp with timezone${exact ? '' : ' or YYYY-MM-DD'}`);
  }
  const ms = Date.parse(iso);
  // Date.parse normalizes invalid calendar dates such as February 30. Reject those.
  const day = iso.slice(0, 10);
  if (!Number.isFinite(ms) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new RetrievalInputError(`invalid ${label} date`);
  }
  return ms;
}

export function prepareBrowse(options: BrowseOptions, asOf: string): PreparedBrowse {
  if (typeof options.entity !== 'string' || options.entity.length > 512) throw new RetrievalInputError('entity must be a string of at most 512 characters');
  const entity = options.entity.normalize('NFKC').trim();
  // Do not use search stopwords or rare-term relaxation: e.g. "The Who", "US",
  // one-letter initials, years and accented names must keep all literal terms.
  // Only letters/numbers enter the quoted FTS expression; caller syntax is inert.
  const terms = [...new Set(entity.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (terms.length === 0 || terms.length > 32) throw new RetrievalInputError('entity must contain 1–32 letter/number terms');
  const anchorMs = timestamp(asOf, 'asOf', false, true);
  const sinceMs = options.since === undefined ? null : timestamp(options.since, 'since');
  const upperMs = Math.min(anchorMs, options.until === undefined ? anchorMs : timestamp(options.until, 'until', true));
  if (sinceMs !== null && sinceMs > upperMs) throw new RetrievalInputError('since must not be later than the effective until/asOf');
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RetrievalInputError('limit must be 1–100');
  const query: BrowseQuery = {
    entity, terms, since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
    until: new Date(upperMs).toISOString(), asOf: new Date(anchorMs).toISOString(), order: 'capture-desc-id-desc',
  };
  // Bind to normalized literal terms and effective range, including the anchor even
  // when until is earlier. Equivalent term case/accent spelling can resume a page.
  const scope = createHash('sha256').update(JSON.stringify([terms, query.since, query.until, query.asOf, query.order])).digest('hex');
  let position: Position | null = null;
  if (options.cursor !== undefined) {
    try {
      if (typeof options.cursor !== 'string' || options.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw new Error();
      const value = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
      if (value.v !== 1 || value.scope !== scope || !Number.isSafeInteger(value.ms) || !Number.isSafeInteger(value.id)
        || value.id <= 0 || value.ms > upperMs || (sinceMs !== null && value.ms < sinceMs)) throw new Error();
      position = { ms: value.ms, id: value.id };
    } catch { throw new RetrievalInputError('invalid browse cursor or cursor belongs to another entity/time range/anchor; reuse the exact returned cursor with the original range, or omit cursor to start a new range'); }
  }
  return {
    query, expression: terms.map(term => `"${term}"`).join(' AND '),
    lowerMs: sinceMs ?? -8640000000000000, upperMs, limit, position,
    cursorFor: ({ ms, id }) => Buffer.from(JSON.stringify({ v: 1, scope, ms, id })).toString('base64url'),
  };
}
