import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256, type AgentTraceSink} from '../tracing/trace-archive.js';

/** Versioned experiment treatment, shared by API, Claude MCP and Codex tools. */
export const PAGED_TOOL_POLICY = {
  version: 'raven-tool-pages-v1', page_chars: 20_000, max_page_chars: 40_000,
  max_result_chars: 200_000, search_text_budget: 120_000,
  offsets: 'UTF-16 code units', reads_count_toward_tool_budget: true,
} as const;
export type ToolDelivery = 'inline' | 'paged';
export function parseToolDelivery(value: string): ToolDelivery {
  if (value !== 'inline' && value !== 'paged') throw new Error('--tool-delivery must be inline or paged');
  return value;
}
type Metadata = {kind: 'article' | 'tool-result' | 'search-excerpt'; url?: string; title?: string;
  crawlDate?: string; publishDate?: string; captured_id?: string};
type Entry = {path: string; sha256: string; total_chars: number; metadata: Metadata};
export class ToolContentStorageError extends Error {}

/** Files and unguessable references belong to one question, never to an arbitrary path/URL. */
export class ToolContentPages {
  private root?: Promise<string>;
  private entries = new Map<string, Entry>();
  constructor(private readonly trace?: AgentTraceSink) {}

  async save(text: string, metadata: Metadata): Promise<string> {
    try {return await this.saveOriginal(text, metadata);}
    catch (cause) {throw cause instanceof ToolContentStorageError ? cause :
      new ToolContentStorageError('Could not archive original tool content', {cause});}
  }

  private async saveOriginal(text: string, metadata: Metadata): Promise<string> {
    this.root ??= mkdtemp(join(tmpdir(), 'raven-tool-pages-'));
    let root: string;
    try {root = await this.root;} catch (cause) {throw new ToolContentStorageError('Could not create tool content storage', {cause});}
    const ref = randomUUID(), path = join(root, ref);
    const hash = sha256(text);
    try {await writeFile(path, text, {encoding: 'utf16le', flag: 'wx', mode: 0o600});}
    catch (cause) {throw new ToolContentStorageError('Could not save original tool content', {cause});}
    const blob = this.trace?.storeTextBlob?.(text);
    this.trace?.record({type: 'tool_content_saved', data: {
      content_ref: ref, ...metadata, total_chars: text.length, sha256: hash,
      body_blob: blob ?? null, ...(blob ? {} : {body: text}),
    }});
    this.entries.set(ref, {path, sha256: hash, total_chars: text.length, metadata});
    return ref;
  }

  async read(ref: string, offset = 0, limit = PAGED_TOOL_POLICY.page_chars as number,
    encodedBudget: number = PAGED_TOOL_POLICY.max_result_chars) {
    const entry = this.entries.get(ref);
    if (!entry) throw new Error('Unknown content_ref for this question; use a reference returned by a tool.');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.total_chars)
      throw new Error('offset must be an integer between 0 and total_chars.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGED_TOOL_POLICY.max_page_chars)
      throw new Error(`limit must be an integer from 1 to ${PAGED_TOOL_POLICY.max_page_chars}.`);
    let text: string;
    try {text = await readFile(entry.path, 'utf16le');}
    catch (cause) {throw new ToolContentStorageError('Could not read saved tool content', {cause});}
    if (sha256(text) !== entry.sha256 || text.length !== entry.total_chars)
      throw new ToolContentStorageError('Saved tool content failed its integrity check');
    // A returned next_offset never bisects a Unicode surrogate pair. Reject a manual one.
    if (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset] ?? ''))
      throw new Error('offset splits a Unicode character; use the returned next_offset.');
    const pageAt = (end: number) => ({...entry.metadata, content_ref: ref, sha256: entry.sha256,
      total_chars: entry.total_chars, offset, end_offset: end,
      next_offset: end < text.length ? end : null, text: text.slice(offset, end)});
    let end = Math.min(text.length, offset + limit);
    // JSON escaping can multiply size: bound the actual serialized output, not raw text.
    while (JSON.stringify(pageAt(end)).length > encodedBudget && end > offset)
      end = offset + Math.floor((end - offset) / 2);
    if (end < text.length && end > offset && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
    if (end === offset && offset < text.length) throw new Error('Page limit is too small for the next character or metadata.');
    const page = pageAt(end);
    if (JSON.stringify(page).length > encodedBudget) throw new Error('Page metadata exceeds the delivery budget');
    return page;
  }

  async close() {
    const root = this.root; this.root = undefined; this.entries.clear();
    const directory = await root?.catch(() => undefined);
    if (directory) await rm(directory, {recursive: true, force: true});
  }
}
