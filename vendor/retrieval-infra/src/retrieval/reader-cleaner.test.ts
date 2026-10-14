import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReaderCleaner, splitReaderBlocks, parseReaderLabels } from './reader-cleaner.js';
import { EvidenceStore, sha256 } from './evidence-store.js';
import { DocumentReader } from './document-reader.js';
import { ProviderApiError } from '../llm/openai-compatible.js';
import { RetrievalInfrastructureError } from './infrastructure-error.js';
import type { LlmClient, LlmCompletion } from '../llm/client.js';
import type { DatedPage } from './page-dater.js';

const main = 'The fictional agency explains its measurement method, including all limitations, and forecasts a future increase to 25.5 units. The article discusses recommended research and advertising markets as substantive topics. Read more detail in the following paragraph.\n\n';
const body = '# Synthetic report\n\n' + main + 'ADVERTISEMENT [Buy a subscription](https://synthetic.example/join)\n\n' +
  'The final paragraph corrects the prior value from 25.4 to 25.5; the revision is essential.\n\n' +
  '| Year | Units |\n| --- | --- |\n| 2030 | 25.5 |\n\n' + '[^1]: Units are adjusted for seasonal variation.\n\n' +
  'MIXED UNCERTAIN: main explanation beside a control.\n\n' + '## More like this\n\n[RELATED CARD next report](https://synthetic.example/next)\n';
function completion(text: string): LlmCompletion { return { text, costUsd: 0.001, inputTokens: 1, outputTokens: 1 }; }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'reader-cleaner-test-')), artifacts = new EvidenceStore(directory);
  let calls = 0;
  const client: LlmClient = { id: 'synthetic:cleaner', async complete(req) {
    calls++;
    const input = JSON.parse(req.prompt);
    assert.equal(input.anchor, undefined); assert.equal(input.question, undefined);
    return completion('Here is the classification.\n```json\n' + JSON.stringify({ labels: Object.fromEntries(input.blocks.map((b: any) => [b.id,
      b.text.includes('ADVERTISEMENT') ? 'advertisement' : /RELATED CARD|## More like this/.test(b.text) ? 'recommendation' :
      b.text.includes('MIXED UNCERTAIN') ? 'unknown' : b.protected ? 'table' : 'main'])), rationale: 'Synthetic article and separate cards.' }) + '\n```');
  } };
  return { directory, artifacts, client, calls: () => calls, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('concurrent documents share two cleanup slots and recover slots after a transport failure', async () => {
  const f = fixture(); let active = 0, peak = 0;
  try {
    const client: LlmClient = { id: 'synthetic:concurrent', async complete(req) {
      active++; peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (JSON.parse(req.prompt).url.endsWith('/0')) throw new Error('transport unavailable');
        return await f.client.complete(req);
      } finally { active--; }
    } };
    const cleaner = new ReaderCleaner(client, f.artifacts, { concurrency: 2 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => cleaner.clean({ url: `https://synthetic.example/${i}`, title: '', body })));
    assert.equal(peak, 2); assert.equal(results.filter(r => r.status === 'fulfilled').length, 4);
    assert.equal(results[0]!.status, 'rejected'); assert.equal(cleaner.snapshot().active, 0);
    assert.equal(cleaner.snapshot().queued, 0);
  } finally { f.close(); }
});

test('blocks partition original bytes represented as UTF-16 text, preserving tables and fenced blocks', () => {
  const input = '  \n' + body + '\n```text\n\n' + 'unchanged 😀 '.repeat(900) + '\n```\n\n<table><tr><td>25</td></tr>\n\n</table>\n';
  const blocks = splitReaderBlocks(input);
  assert.equal(blocks.map(b => b.text).join(''), input);
  for (let i = 0; i < blocks.length; i++) {
    assert.equal(blocks[i]!.start, i ? blocks[i - 1]!.end : 0);
    assert.equal(input.slice(blocks[i]!.start, blocks[i]!.end), blocks[i]!.text);
  }
  assert.ok(blocks.find(b => b.text.includes('```text'))!.protected);
  assert.ok(blocks.find(b => b.text.includes('| Year'))!.protected);
  assert.ok(blocks.find(b => b.text.includes('[^1]'))!.protected);
  assert.ok(blocks.find(b => b.text.includes('<table>'))!.protected);
});

test('LLM chooses exact original blocks, preserving future forecasts, corrections, tables, footnotes and uncertain text', async () => {
  const f = fixture();
  try {
    const cleaner = new ReaderCleaner(f.client, f.artifacts);
    const result = await cleaner.clean({ url: 'https://synthetic.example/report', title: 'Synthetic', body });
    assert.equal(result.status, 'cleaned');
    assert.doesNotMatch(result.body, /ADVERTISEMENT|RELATED CARD|## More like this/);
    for (const required of [main, 'corrects the prior value', '| 2030 | 25.5 |', '[^1]: Units', 'MIXED UNCERTAIN']) assert.ok(result.body.includes(required));
    const receipt = f.artifacts.get<any>(result.receiptId);
    assert.equal(receipt.blocks.filter((b: any) => result.decisions.find(d => d.id === b.id)?.action === 'keep').map((b: any) => b.text).join(''), result.body);
    assert.equal(receipt.output_sha256, sha256(result.body));
    assert.equal(receipt.trace.length, 1); assert.equal(result.costUsd, 0.001);
  } finally { f.close(); }
});

test('table and footnote deletion requests are overridden and recorded', async () => {
  const f = fixture();
  try {
    const client: LlmClient = { id: 'synthetic:bad-table-label', async complete(req) {
      const data = JSON.parse(req.prompt);
      return completion(JSON.stringify({ labels: Object.fromEntries(data.blocks.map((b: any) => [b.id, b.protected ? 'recommendation' : 'main'])), rationale: 'Deliberately wrong protected labels.' }));
    } };
    const result = await new ReaderCleaner(client, f.artifacts).clean({ url: 'https://synthetic.example/report', title: '', body });
    assert.ok(result.body.includes('| 2030 | 25.5 |'));
    assert.ok(result.body.includes('[^1]:'));
    assert.ok(result.decisions.some(d => d.reason.includes('overrides')));
  } finally { f.close(); }
});

test('invalid/missing labels get one bounded format repair; exhausted budgets fail with full traces', async () => {
  const f = fixture();
  try {
    let attempt = 0;
    const client: LlmClient = { id: 'synthetic:repair', async complete(req) {
      attempt++; if (attempt === 1) return completion('{"labels":{},"rationale":"missing"}');
      assert.ok(JSON.parse(req.prompt).format_error); return f.client.complete(req);
    } };
    const cleaned = await new ReaderCleaner(client, f.artifacts).clean({ url: 'https://synthetic.example/report', title: '', body });
    assert.equal(cleaned.status, 'cleaned'); assert.equal(cleaned.modelCalls, 2); assert.equal(cleaned.costUsd, 0.002);
    const invalid: LlmClient = { id: 'synthetic:invalid', async complete() { return completion('not JSON'); } };
    const failed = await new ReaderCleaner(invalid, f.artifacts).clean({ url: 'https://synthetic.example/report', title: '', body });
    assert.equal(failed.status, 'failed'); assert.equal(failed.modelCalls, 2); assert.equal(failed.body, '');
    const budget = await new ReaderCleaner(f.client, f.artifacts, { batchChars: 6000, maxModelCalls: 1 }).clean({ url: 'https://synthetic.example/long', title: '', body: main.repeat(60) });
    assert.equal(budget.status, 'failed'); assert.equal(budget.modelCalls, 1);
    assert.throws(() => parseReaderLabels('{"labels":{"invented":"main"},"rationale":"x"}', splitReaderBlocks('paragraph')), /exactly/);
    assert.throws(() => parseReaderLabels('{"labels":{}} {"labels":{}}', []));
  } finally { f.close(); }
});

test('same text shares work and cached selection across sessions; configuration changes invalidate it', async () => {
  const f = fixture();
  try {
    const input = { url: 'https://synthetic.example/report', title: '', body }, options = { cacheDirectory: join(f.directory, 'cache') };
    const cleaner = new ReaderCleaner(f.client, f.artifacts, options);
    const [a, b] = await Promise.all([cleaner.clean(input), cleaner.clean(input)]);
    assert.equal(f.calls(), 1); assert.equal(a.receiptId, b.receiptId); assert.equal(a.costUsd + b.costUsd, 0.001);
    const replay = await new ReaderCleaner(f.client, f.artifacts, options).clean(input);
    assert.equal(replay.cacheHit, true); assert.equal(f.calls(), 1);
    await new ReaderCleaner(f.client, f.artifacts, { ...options, maxCostUsd: 0.2 }).clean(input);
    assert.equal(f.calls(), 2);
  } finally { f.close(); }
});

test('Reader integration retains raw provenance, cleans before hashing, and does not clean direct HTML', async () => {
  const f = fixture();
  try {
    const cleaner = new ReaderCleaner(f.client, f.artifacts);
    const reader = new DocumentReader(async urls => urls.map(url => ({ url, title: 'Synthetic', source: url.endsWith('direct') ? 'direct' : 'reader',
      text: body, date: '2020-01-01', why: 'synthetic', content_document: { policy: 'article-blocks-tables-v1', extractor: 'reader-output',
        body_sha256: sha256(body), usable: true, complete: true, unusable_reason: null, source_format: 'reader-markdown', blocks: [] } } as DatedPage)), f.artifacts, undefined, cleaner);
    const a = (await reader.read('https://synthetic.example/report', '2026-03-01T00:00:00Z'))!;
    const b = (await reader.read('https://synthetic.example/report', '2020-03-01T00:00:00Z'))!;
    assert.equal(a.body, b.body); assert.equal(a.cleaningReceiptId, b.cleaningReceiptId); assert.equal(f.calls(), 1);
    assert.equal(a.bodySha256, sha256(a.body)); assert.notEqual(a.bodySha256, sha256(body));
    assert.equal(f.artifacts.get<any>(a.provenanceId).page.text, body);
    const direct = (await reader.read('https://synthetic.example/direct', '2026-03-01T00:00:00Z'))!;
    assert.equal(direct.body, body); assert.equal(direct.cleaningReceiptId, undefined);
  } finally { f.close(); }
});

test('navigation-only output is unusable; content refusal stays local while authentication remains fatal', async () => {
  const f = fixture();
  try {
    const nav = await new ReaderCleaner(f.client, f.artifacts).clean({ url: 'https://synthetic.example/nav', title: '', body: 'RELATED CARD [story](https://synthetic.example/next)\n\n'.repeat(10) });
    assert.equal(nav.status, 'unusable');
    const refusal: LlmClient = { id: 'synthetic:refusal', async complete() { throw new ProviderApiError('deepseek', 400, 'http_error', false, 'invalid_request_error', 'Content Exists Risk (request_id: 52bec2cb-6ded-4736-ae62-d06f2588bc6f)'); } };
    assert.equal((await new ReaderCleaner(refusal, f.artifacts).clean({ url: 'https://synthetic.example/report', title: '', body })).status, 'failed');
    const auth: LlmClient = { id: 'synthetic:auth', async complete() { throw new ProviderApiError('deepseek', 401, 'authentication', false, null, 'invalid key'); } };
    await assert.rejects(new ReaderCleaner(auth, f.artifacts).clean({ url: 'https://synthetic.example/report', title: '', body }), RetrievalInfrastructureError);
  } finally { f.close(); }
});
