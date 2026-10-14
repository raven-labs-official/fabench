import type {ToolDelivery} from './tool-content-pages.js';

export const FROZEN_LEAD_POLICY = {
  version: 'frozen-leading-text-v1', max_chars: 500,
  characters: 'Unicode code points', boundary: 'last sentence-ending punctuation within prefix; hard prefix if none',
  source: 'original captured text', model_calls: 0,
} as const;
export type FrozenSearchDelivery = 'lead' | 'fulltext';
export function parseFrozenSearchDelivery(value: string): FrozenSearchDelivery {
  if (value !== 'lead' && value !== 'fulltext') throw new Error('--frozen-search-delivery must be lead or fulltext');
  return value;
}
export function frozenSearchDeliveryDefault(delivery: ToolDelivery, quality: boolean): FrozenSearchDelivery {
  return delivery === 'paged' && quality ? 'lead' : 'fulltext';
}
/** Exact prefix, never generated text. Offsets remain UTF-16, like web_fetch. */
export function frozenLead(body: string): {text: string; offset: number; end_offset: number} {
  const offset = body.length - body.trimStart().length;
  const original = body.slice(offset);
  let prefix = '', characters = 0;
  for (const character of original) {
    if (characters++ >= FROZEN_LEAD_POLICY.max_chars) break;
    prefix += character;
  }
  let end = prefix.length;
  if (end < original.length) {
    let sentenceEnd = 0;
    // A deterministic punctuation heuristic, not linguistic summarization. Only
    // scan the bounded prefix; a multi-megabyte first sentence costs no extra work.
    for (const match of original.slice(0, prefix.length + 1).matchAll(/(?:[.!?]["'”’）)]*(?=\s)|[。！？]["'”’）)]*)/gu)) {
      const next = match.index + match[0].length;
      if (next <= prefix.length) sentenceEnd = next;
    }
    if (sentenceEnd) end = sentenceEnd;
  }
  return {text: original.slice(0,end), offset, end_offset: offset+end};
}
