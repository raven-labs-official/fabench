import type {ReaderBlock} from './reader-cleaner.js';

/** The model selects source locations; the program copies their original text. */
export const APPROVED_SUMMARY_POLICY = 'approved-source-fragments-v2';
export const SUMMARY_INSTRUCTIONS = `In the SAME final JSON decision add "summaryFragmentIds": an array of IDs from the supplied article fragments, ordered by their importance for a short article summary. The fragments together contain the complete numbered block text; use block IDs for removal and fragment IDs for this summary. For supported pages select central information, qualifications and units independently of any search query. Usually select 3–8 useful fragments, aiming for 300–500 characters. Select only fragments in retained blocks. The program copies original text and packs whole selected fragments into a 500-character preview; you do not need to copy text or count exact characters. Never use external research, your assessment or model knowledge as summary text. Return [] for leaked/unknown. Do not make an additional tool or model call just to summarize.`;

export interface SummaryFragment { id: string; blockId: string; text: string }
/** Preserve every character and sentence where possible, bounding unusually long sentences. */
export function summaryFragments(blocks: readonly ReaderBlock[]): SummaryFragment[] {
  const fragments: SummaryFragment[] = [];
  const segmenter = new Intl.Segmenter('en', {granularity: 'sentence'});
  for (const block of blocks) {
    for (const {segment} of segmenter.segment(block.text)) {
      const chars = [...segment];
      let start = 0;
      while (start < chars.length) {
        let end = Math.min(chars.length, start + 480);
        if (chars.length > end) {
          // Keep a whole word/line boundary unless the source is one very long token.
          for (let i = end - 1; i >= start + (end - start) / 2; i--) {
            if (/\s/u.test(chars[i]!)) {end = i + 1; break;}
          }
        }
        fragments.push({id: `f${String(fragments.length + 1).padStart(5, '0')}`, blockId: block.id, text: chars.slice(start, end).join('')});
        start = end;
      }
    }
  }
  return fragments;
}

export function summaryPromptBlocks(blocks: readonly ReaderBlock[], fragments: readonly SummaryFragment[]) {
  const byBlock = new Map<string, {id: string; text: string}[]>();
  for (const {id, blockId, text} of fragments) {
    const group = byBlock.get(blockId) ?? [];
    group.push({id, text}); byBlock.set(blockId, group);
  }
  return blocks.map(({id, protected: guard}) => ({id, protected: guard, fragments: byBlock.get(id) ?? []}));
}

export function approvedSummary(body: string, fragments: readonly SummaryFragment[], selectedIds: unknown, removedBlocks: readonly string[]): string {
  if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 12)
    throw new Error('Summary needs 1–12 source fragment IDs');
  const byId = new Map(fragments.map(f => [f.id, f]));
  const removed = new Set(removedBlocks);
  const selected = [...new Set(selectedIds)].map(id => {
    const fragment = typeof id === 'string' ? byId.get(id) : undefined;
    if (!fragment || removed.has(fragment.blockId) || !body.includes(fragment.text))
      throw new Error('Summary fragment must belong to the retained article');
    return fragment.text.trim();
  });
  const packed: string[] = [];
  let characters = 0;
  for (const text of selected) {
    if (!text) continue;
    const added = [...text].length + Number(packed.length > 0);
    if (characters + added > 500) continue;
    packed.push(text); characters += added;
  }
  if (!packed.length) throw new Error('No nonempty source fragment fits the summary');
  return packed.join('\n');
}
/** Proven historical versions need no review call: expose a labelled lead excerpt. */
export function historicalExcerpt(body: string): string {
  return [...body.trim()].slice(0, 500).join('');
}
