import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedSummary,historicalExcerpt,summaryFragments,summaryPromptBlocks} from './approved-summary.js';
import {selectSinglePassText} from './single-pass-content.js';
import {splitReaderBlocks} from './reader-cleaner.js';

test('summary cannot reintroduce deleted recommendations or external evidence',()=>{
  const text='Quarterly revenue rose 4%; currency-neutral growth was 6%.\n\nRecommended: September results have been announced.\n';
  const blocks=splitReaderBlocks(text);
  const fragments=summaryFragments(blocks);
  const selected=selectSinglePassText(JSON.stringify({status:'supported',reason:'Old report',remove:[{from:blocks[1]!.id,role:'recommendation',reason:'Independent recommendation'}]}),blocks);
  assert.equal(approvedSummary(selected.body,fragments,[fragments[0]!.id],selected.removed),selected.body.trim());
  const removed=fragments.find(f=>f.blockId===blocks[1]!.id)!;
  assert.throws(()=>approvedSummary(selected.body,fragments,[removed.id],selected.removed));
  assert.throws(()=>approvedSummary(selected.body,fragments,['f99999'],selected.removed));
  assert.throws(()=>approvedSummary(selected.body,fragments,[],selected.removed));
  assert.equal([...historicalExcerpt('𠀀'.repeat(501))].length,500);
});

test('fragment input preserves the entire article, Unicode and block removal identities',()=>{
  const body='First sentence. Second sentence with **qualifications** and [a source](https://example.test).\n\n'+
    '| Revenue | Units |\n| 42 | million USD |\n\n'+('𠀀很长的句子 '.repeat(200))+'\n\nLast paragraph.\n';
  const blocks=splitReaderBlocks(body),fragments=summaryFragments(blocks),prompt=summaryPromptBlocks(blocks,fragments);
  assert.equal(new Set(fragments.map(f=>f.id)).size,fragments.length);
  for(const block of blocks){
    assert.equal(prompt.find(p=>p.id===block.id)!.fragments.map(f=>f.text).join(''),block.text);
    assert.equal(prompt.find(p=>p.id===block.id)!.protected,block.protected);
  }
  assert.ok(fragments.every(f=>[...f.text].length<=480));
  assert.equal(fragments.map(f=>f.text).join(''),blocks.map(b=>b.text).join(''));
  assert.ok(fragments.every(f=>!/[\ud800-\udbff]$/u.test(f.text)));
});

test('packing a long model selection copies whole fragments within the display budget',()=>{
  const body='A'.repeat(300)+'.\n\n'+'B'.repeat(250)+'.\n\n'+'C'.repeat(170)+'.';
  const fragments=summaryFragments(splitReaderBlocks(body));
  const preview=approvedSummary(body,fragments,fragments.map(f=>f.id),[]);
  assert.equal(preview,'A'.repeat(300)+'.\n'+'C'.repeat(170)+'.');
  assert.ok([...preview].length<=500);
  assert.equal(approvedSummary(body,fragments,[fragments[0]!.id,fragments[0]!.id],[]),'A'.repeat(300)+'.');
  // Repeated text does not authorize selecting a removed block with the same words.
  assert.throws(()=>approvedSummary(body,fragments,[fragments[0]!.id],[fragments[0]!.blockId]));
});
