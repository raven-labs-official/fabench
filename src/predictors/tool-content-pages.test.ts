import test from 'node:test';
import assert from 'node:assert/strict';
import {access, writeFile} from 'node:fs/promises';
import {ToolContentPages, ToolContentStorageError, PAGED_TOOL_POLICY} from './tool-content-pages.js';
import {AgenticSearchPredictor} from './agentic-search.js';
import type {SearchBackend} from '../retrieval/search-backend.js';
import {sha256} from '../tracing/trace-archive.js';

test('file pages reconstruct the entire Unicode original, reject invalid offsets and isolate questions', async () => {
  const events: any[] = [], pages = new ToolContentPages({record: e => events.push(e)}), other = new ToolContentPages();
  const body = ('原文🙂\n\t"\\\u0001' + 'a'.repeat(97)).repeat(12000);
  let path: string;
  try {
    const ref = await pages.save(body, {kind: 'article', url: 'https://example.test/article'});
    path = (pages as any).entries.get(ref).path;
    let offset = 0, restored = '';
    do {
      const page = await pages.read(ref, offset);
      assert.ok(JSON.stringify(page).length <= PAGED_TOOL_POLICY.max_result_chars);
      assert.equal(page.sha256, sha256(body)); assert.equal(page.total_chars, body.length);
      assert.ok(page.text.isWellFormed()); restored += page.text;
      if (page.next_offset === null) break;
      assert.ok(page.next_offset > offset); offset = page.next_offset;
    } while (true);
    assert.equal(restored, body);
    assert.equal(events[0].data.body, body);
    for (const offset of [-1, 0.5, body.length + 1, NaN, Infinity]) await assert.rejects(pages.read(ref, offset), /offset/);
    for (const limit of [0, -1, 1.5, 40001, Infinity]) await assert.rejects(pages.read(ref, 0, limit), /limit/);
    await assert.rejects(pages.read(ref, 3), /Unicode/);
    await assert.rejects(other.read(ref), /Unknown content_ref/);
    await assert.rejects(pages.read('/etc/passwd'), /Unknown content_ref/);
    assert.equal((await pages.read(ref, body.length)).next_offset, null);
    await writeFile(path, 'altered', 'utf16le');
    await assert.rejects(pages.read(ref), ToolContentStorageError);
  } finally {await pages.close(); await other.close();}
  await assert.rejects(access(path!));
});

test('search pages retain every result and full capture text; continuation never refetches a URL', async () => {
  const first = ('原文🙂\u0000"\\').repeat(20000), second = 'different historical capture\n'.repeat(25000);
  let fetched = 0;
  const backend: SearchBackend = {name: 'frozen', fullTextResults: true,
    async search() {return Array.from({length: 20}, (_, i) => ({url: 'https://example.test/same', title: 'capture ' + i, snippet: i % 2 ? second : first}));},
    async fetch() {fetched++; return {url: 'https://example.test/same', title: 'new version', body: 'not the saved capture', source: 'frozen'};},
    stats() {return {};}};
  const events: any[] = [];
  const predictor = new AgenticSearchPredictor({id: 'fake', async complete() {throw new Error('not called');}}, backend,
    {toolDelivery: 'paged', trace: {record: e => events.push(e)}});
  const call = async (name: string, args: any) => (predictor as any).runTool(name, args, '2026-03-01T00:00:00Z');
  try {
    const response = await call('web_search', {query: 'capture'});
    assert.ok(response.content.length <= PAGED_TOOL_POLICY.max_result_chars);
    const rows = JSON.parse(response.content).results;
    assert.equal(rows.length, 20);
    assert.equal(response.results[0].snippet, rows[0].snippet, 'trace describes delivered page, not the full original');
    for (const [index, original] of [[0, first], [1, second]] as const) {
      let restored = rows[index].snippet, offset = rows[index].next_offset;
      while (offset !== null) {
        const result = await call('web_fetch', {content_ref: rows[index].content_ref, offset});
        const page = JSON.parse(result.content); restored += page.text; offset = page.next_offset;
        assert.equal(result.fetched.chars, page.text.length); assert.equal(result.fetched.sha256, sha256(original));
        assert.ok(result.content.length <= PAGED_TOOL_POLICY.max_result_chars);
      }
      assert.equal(restored, original);
    }
    assert.equal(fetched, 0);
    const audit = {candidates: []};
    (backend as any).fetchWithTrace = async (url: string) => ({doc: await backend.fetch(url, '2026-03-01'), audit});
    const firstRead = await call('web_fetch', {url: 'https://example.test/same'});
    const secondRead = await call('web_fetch', {url: 'https://example.test/same'});
    const one = JSON.parse(firstRead.content), two = JSON.parse(secondRead.content);
    assert.deepEqual(firstRead.audit, audit); assert.equal(secondRead.audit, undefined);
    assert.equal(one.content_ref, two.content_ref); assert.equal(fetched, 1);
    assert.ok(events.some(e => e.type === 'tool_content_saved' && e.data.body === first));
    for (const args of [{url: 'u', content_ref: rows[0].content_ref}, {content_ref: '../../etc/passwd'},
      {content_ref: rows[0].content_ref, offset: -1}, {url: 'u', limit: 0}])
      assert.ok(JSON.parse((await call('web_fetch', args)).content).error);
  } finally {await (predictor as any).pages.close();}
});

test('an oversized result envelope is saved losslessly instead of becoming a CLI preview', async () => {
  const rows = [{url: 'https://example.test/report', title: 'X'.repeat(600000), snippet: 'report text'}];
  const backend: SearchBackend = {name: 'frozen', fullTextResults: true, async search() {return rows;}, async fetch() {return null;}, stats() {return {};}};
  const predictor = new AgenticSearchPredictor({id: 'fake', async complete() {throw Error('not called');}}, backend, {toolDelivery: 'paged'});
  const call = (name: string, args: any) => (predictor as any).runTool(name, args, '2026-03-01');
  try {
    let page = JSON.parse((await call('web_search', {query: 'report'})).content), restored = page.text;
    assert.equal(page.kind, 'tool-result');
    while (page.next_offset !== null) {
      page = JSON.parse((await call('web_fetch', {content_ref: page.content_ref, offset: page.next_offset})).content);
      restored += page.text;
    }
    assert.deepEqual(JSON.parse(restored), {results: rows});
  } finally {await (predictor as any).pages.close();}
});
