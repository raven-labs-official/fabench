import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EvidenceStore, sha256 } from './evidence-store.js';
import { DocumentReader, type EvidenceDocument } from './document-reader.js';
import { EvidenceReviewer, validateEvidence } from './evidence-reviewer.js';
import { QualityWebBackend } from './quality-backend.js';
import type { LlmClient, LlmCompletion } from '../llm/client.js';
import type { SearchProvider } from './search-providers.js';
import type { DatedPage } from './page-dater.js';
import { ProviderApiError } from '../llm/openai-compatible.js';
import { RetrievalInfrastructureError } from './infrastructure-error.js';

const anchor = '2026-03-01T00:00:00Z';
const candidateUrl = 'https://synthetic.example/candidate';
const sourceUrl = 'https://synthetic.example/source';
const claim = 'The fictional index was 12.5 points.';
const sourceBody = `On February 20, 2026, the agency released its observation: ${claim} It explained the instrument and the method used to collect this observation.`;
function page(url: string, body: string): DatedPage {
  return { url, title: 'Synthetic report', text: body, date: null, why: 'no date', source: 'direct',
    content_document: { policy: 'article-blocks-tables-v1', extractor: 'synthetic', body_sha256: sha256(body), usable: true,
      unusable_reason: null, complete: true, source_format: 'html', blocks: [] } };
}
function response(text = '', toolCalls?: LlmCompletion['toolCalls']): LlmCompletion {
  return { text, toolCalls, costUsd: 0.001, inputTokens: 10, outputTokens: 10 };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'fabench-evidence-test-'));
  const artifacts = new EvidenceStore(directory);
  let searches = 0, reads = 0, modelCalls = 0;
  const provider: SearchProvider = { name: 'synthetic', async search(query) { searches++; return [{ url: query === 'initial' ? candidateUrl : sourceUrl, title: 'SEARCH TITLE WITH FUTURE INFORMATION', snippet: 'future search snippet' }]; }, stats: () => ({ requests: searches, failed: 0 }) };
  const reader = new DocumentReader(async urls => { reads += urls.length; return urls.map(url => page(url, url === sourceUrl ? sourceBody : claim)); }, artifacts);
  const client: LlmClient = { id: 'synthetic:reviewer', async complete(req) {
    modelCalls++;
    const source = [...(req.messages ?? [])].reverse().find(m => m.role === 'tool' && m.content.includes('sourceId'));
    const searched = req.messages?.find(m => m.role === 'tool');
    if (!searched) return response('', [{ id: 's', name: 'search_evidence', args: { query: 'verify historical release', scope: 'historical' } }]);
    if (!source) return response('', [{ id: 'r', name: 'read_source', args: { url: sourceUrl } }]);
    return response(JSON.stringify({ status: 'supported', reason: 'same observation in dated release', evidence: [{
      sourceId: JSON.parse(source.content).sourceId, candidateQuote: claim, sourceQuote: sourceBody,
      relation: 'pre_anchor_support', timeQuote: 'February 20, 2026', time: '2026-02-20' }] }));
  } };
  return { directory, artifacts, provider, reader, client, counts: () => ({ searches, reads, modelCalls }),
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('judge actually searches and reads; simultaneous calls share work and a fresh instance replays saved evidence', async () => {
  const f = fixture();
  try {
    const doc = (await f.reader.read(candidateUrl, anchor))!;
    const opts = { cacheDirectory: join(f.directory, 'cache') };
    const reviewer = new EvidenceReviewer(f.client, f.provider, f.reader, f.artifacts, opts);
    const [a, b] = await Promise.all([reviewer.review(doc, anchor), reviewer.review(doc, anchor)]);
    assert.equal(a.status, 'supported'); assert.equal(a.basis, 'corroborated-content');
    assert.equal(a.receiptId, b.receiptId); assert.equal(f.counts().modelCalls, 3);
    assert.equal(a.costUsd + b.costUsd, 0.003); assert.equal(a.searchCalls + b.searchCalls, 1);
    const replay = await new EvidenceReviewer(f.client, f.provider, f.reader, f.artifacts, opts).review(doc, anchor);
    assert.equal(replay.cacheHit, true); assert.equal(replay.costUsd, 0); assert.equal(f.counts().modelCalls, 3);
    await reviewer.review(doc, anchor, { question: 'a different question' });
    assert.equal(f.counts().modelCalls, 6);
    assert.ok(f.artifacts.get(a.receiptId));
  } finally { f.close(); }
});

test('fabricated time quotes and a later page timestamp without issue evidence cannot establish availability', async () => {
  const f = fixture();
  try {
    const source = (await f.reader.read(sourceUrl, anchor))!;
    const sources = new Map([[source.id, source]]), views = new Map([[source.id, [source.body]]]);
    const base = { sourceId: source.id, candidateQuote: claim, sourceQuote: sourceBody, relation: 'pre_anchor_support', time: '2026-02-20', timeQuote: 'February 20, 2026' };
    assert.equal(validateEvidence({ status: 'supported', reason: 'ok', evidence: [base] }, claim, anchor, sources, views).status, 'supported');
    assert.throws(() => validateEvidence({ status: 'supported', reason: 'fake date', evidence: [{ ...base, time: '2026-01-01' }] }, claim, anchor, sources, views), /time evidence/);
    assert.throws(() => validateEvidence({ status: 'leaked', reason: 'page is later', evidence: [{ ...base, relation: 'post_anchor_release', time: '2026-09-10', timeQuote: '' }] }, claim, anchor, sources, views), /time evidence/);
    assert.throws(() => validateEvidence({ status: 'supported', reason: 'not read', evidence: [base] }, claim, anchor, sources, new Map()), /not read/);
  } finally { f.close(); }
});

test('a confirmed later issue is distinguished from unknown, including the exact-time boundary', () => {
  const text = `On March 10, 2026, the agency issued the revised result. ${claim}`;
  const source = { id: 's', body: text, temporalBasis: 'live-page' } as EvidenceDocument;
  const citation = { sourceId: 's', candidateQuote: claim, sourceQuote: text, relation: 'post_anchor_release', timeQuote: 'March 10, 2026', time: '2026-03-10' };
  const sources = new Map([['s', source]]), views = new Map([['s', [text]]]);
  assert.equal(validateEvidence({ status: 'leaked', reason: 'later revision', evidence: [citation] }, claim, anchor, sources, views).status, 'leaked');
  assert.throws(() => validateEvidence({ status: 'leaked', reason: 'uncertain time', evidence: [citation] }, claim, '2026-03-10T12:00:00Z', sources, views), /unresolved within the day/);
});

test('budget exhaustion and unsupported conclusions remain unknown', async () => {
  const f = fixture();
  try {
    const doc = (await f.reader.read(candidateUrl, anchor))!;
    const result = await new EvidenceReviewer(f.client, f.provider, f.reader, f.artifacts, { maxModelCalls: 1 }).review(doc, anchor);
    assert.equal(result.status, 'unknown'); assert.equal(result.modelCalls, 1);
    const noTools: LlmClient = { id: 'synthetic:memory-only', async complete() { return response(JSON.stringify({ status: 'supported', reason: 'I remember it', evidence: [] })); } };
    assert.equal((await new EvidenceReviewer(noTools, f.provider, f.reader, f.artifacts).review(doc, anchor)).status, 'unknown');
  } finally { f.close(); }
});

test('validation feedback retains evidence context, repairs once and returns each turn with its own reasoning', async () => {
  const f=fixture();let broken=false;let feedbackSeen=false;
  const client:LlmClient={id:'synthetic:repair',async complete(req){
    assert.ok(req.messages?.every(m=>!('reasoning_content' in m)&&(m.role==='assistant'?typeof m.reasoning==='string':!('reasoning' in m))));
    const r=await f.client.complete(req);
    if (!r.toolCalls?.length && !broken) {broken=true;return {...r,text:'Explanation before JSON. '+r.text,reasoning:'PRIVATE_REVIEW_THOUGHT'};}
    if (broken) {
      const feedback=JSON.parse(req.messages!.at(-1)!.content);
      assert.equal(feedback.code,'invalid_json');
      assert.ok(req.messages!.some(m=>m.role==='tool' && m.content.includes(sourceBody)));
      assert.ok(req.messages!.some(m=>m.role==='assistant' && m.content.startsWith('Explanation')));
      assert.ok(req.messages!.some(m=>m.role==='assistant' && m.content.startsWith('Explanation') && m.reasoning==='PRIVATE_REVIEW_THOUGHT'));feedbackSeen=true;
    }
    return r;
  }};
  try {
    const doc=(await f.reader.read(candidateUrl,anchor))!;
    const result=await new EvidenceReviewer(client,f.provider,f.reader,f.artifacts).review(doc,anchor);
    assert.equal(result.status,'supported');assert.equal(result.modelCalls,4);assert.equal(feedbackSeen,true);
    const objects=readdirSync(f.directory).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(join(f.directory,n),'utf8')));
    assert.ok(objects.some(x=>x.completion?.reasoning==='PRIVATE_REVIEW_THOUGHT'));
    assert.ok(objects.some(x=>x.trace?.some((t:any)=>t.validation?.code==='invalid_json')));
  } finally {f.close();}
});

test('exhausted validation repairs are page failures and never persist as historical unknown judgments', async () => {
  const f=fixture();let calls=0;
  const client:LlmClient={id:'synthetic:invalid',async complete(){calls++;return response('not JSON');}};
  try {
    const doc=(await f.reader.read(candidateUrl,anchor))!,options={cacheDirectory:join(f.directory,'cache'),maxValidationRepairs:1};
    const reviewer=new EvidenceReviewer(client,f.provider,f.reader,f.artifacts,options);
    const a=await reviewer.review(doc,anchor);assert.equal(a.failure?.kind,'validation-error');assert.equal(a.modelCalls,2);
    assert.deepEqual(readdirSync(options.cacheDirectory),[]);
    assert.equal((await reviewer.review(doc,anchor)).cacheHit,true);assert.equal(calls,2);
    await new EvidenceReviewer(client,f.provider,f.reader,f.artifacts,options).review(doc,anchor);assert.equal(calls,4);
    const budget=await new EvidenceReviewer(f.client,f.provider,f.reader,f.artifacts,{maxModelCalls:1}).review(doc,anchor);
    assert.equal(budget.failure?.kind,'budget-exhausted');
  } finally {f.close();}
});

test('an unreviewed tail cannot be served after the first passage clears', async () => {
  const f = fixture();
  try {
    const doc = (await f.reader.read(candidateUrl, anchor))!;
    doc.body = claim + ' Additional context. '.repeat(200); doc.bodySha256 = sha256(doc.body);
    const result = await new EvidenceReviewer(f.client, f.provider, f.reader, f.artifacts, { chunkChars: 500, maxModelCalls: 3 }).review(doc, anchor);
    assert.equal(result.status, 'unknown'); assert.match(result.reason, /every passage/);
  } finally { f.close(); }
});

test('only an actually fetched and hash-verified pre-anchor revision receives historical-version status', async () => {
  const f = fixture();
  try {
    const body = `'''Synthetic institution'''\n${claim}`;
    let raw = JSON.stringify({ query: { pages: [{ pageid: 1, title: 'FUTURE RENAMED TITLE', revisions: [{ revid: 42, timestamp: '2026-02-20T09:00:00Z', sha1: createHash('sha1').update(body).digest('hex'), slots: { main: { content: body, contentmodel: 'wikitext' } } }] }] } });
    const reader = new DocumentReader(async () => { throw new Error('must not use live Wikipedia fallback'); }, f.artifacts, async () => raw);
    const doc = (await reader.read('https://en.wikipedia.org/wiki/Synthetic_institution', anchor))!;
    assert.equal(doc.version, '42'); assert.equal(doc.title, 'Synthetic institution');
    assert.equal(doc.temporalBasis, 'wikipedia-revision');
    const review = await new EvidenceReviewer(f.client, f.provider, reader, f.artifacts).review(doc, anchor);
    assert.equal(review.basis, 'historical-version'); assert.equal(review.modelCalls, 0);
    raw = raw.replace('2026-02-20T09:00:00Z', '2026-09-20T09:00:00Z');
    assert.equal(await reader.read('https://en.wikipedia.org/wiki/Another_title', anchor), null);
  } finally { f.close(); }
});

test('agent output contains only approved content, and pagination uses the same document', async () => {
  const f = fixture();
  try {
    const reviewer = new EvidenceReviewer(f.client, f.provider, f.reader, f.artifacts);
    const backend = new QualityWebBackend(f.provider, f.reader, reviewer, f.artifacts, 12);
    const result = await backend.searchWithTrace('initial', 1, anchor, { question: 'test' });
    assert.equal(result.results.length, 1);
    assert.doesNotMatch(JSON.stringify(result.results), /FUTURE|future search|February 20/);
    const first = result.results[0]!;
    const rest = (await backend.fetchSlice(first.url, anchor, { question: 'test' }, first.nextOffset!, 0))!;
    assert.equal(rest.documentId, first.documentId);
    assert.equal(first.snippet + rest.body, claim);
    assert.equal(f.counts().modelCalls, 3);
    assert.equal(result.audit?.candidates[0]?.served_to_forecaster, true);
    const receipt = f.artifacts.get<any>(result.audit!.candidates[0]!.evidence_receipt_id!);
    assert.equal(receipt.searchCalls, 1);
  } finally { f.close(); }
});

test('a content rejection withholds one page, preserves spent work and lets another page through', async () => {
  const f = fixture();
  try {
    const bad = 'https://synthetic.example/rejected';
    const provider: SearchProvider = { ...f.provider, async search(query) {
      return query === 'initial' ? [{ url: bad, title: 'bad' }, { url: candidateUrl, title: 'good' }] : f.provider.search(query, 5);
    } };
    let refusals = 0;
    const client: LlmClient = { ...f.client, async complete(req) {
      if (req.messages?.some(m => m.role === 'user' && JSON.parse(m.content).candidateUrl === bad) &&
          req.messages.some(m => m.role === 'tool')) {
        refusals++;
        throw new ProviderApiError('deepseek', 400, 'http_error', false, 'invalid_request_error', 'Content Exists Risk (request_id: 52bec2cb-6ded-4736-ae62-d06f2588bc6f)');
      }
      return f.client.complete(req);
    } };
    const options = { cacheDirectory: join(f.directory, 'cache') };
    const reviewer = new EvidenceReviewer(client, provider, f.reader, f.artifacts, options);
    const backend = new QualityWebBackend(provider, f.reader, reviewer, f.artifacts);
    const result = await backend.searchWithTrace('initial', 2, anchor);
    assert.deepEqual(result.results.map(r => r.url), [candidateUrl]);
    assert.equal(result.audit!.candidates[0]!.final_disposition, 'review_failed');
    assert.equal(result.funnel!.leak_review_failed, 1);
    assert.equal(result.funnel!.uncertainty_dropped, 0);
    assert.doesNotMatch(JSON.stringify(result.results), /Risk|rejected|future/);
    const receipt = f.artifacts.get<any>(result.audit!.candidates[0]!.evidence_receipt_id!);
    assert.equal(receipt.failure.kind, 'provider-content-rejection');
    assert.equal(receipt.modelCalls, 1); assert.equal(receipt.costUsd, 0.001);
    assert.ok(receipt.trace.some((t: any) => t.requestId && t.failure));
    const fetched = await backend.fetchWithTrace(bad, anchor);
    assert.equal(fetched.doc, null); assert.equal(fetched.audit!.candidates[0]!.final_disposition, 'review_failed');
    assert.equal(refusals, 1); // Within-run duplicate requests share the failed receipt.
    await new EvidenceReviewer(client, provider, f.reader, f.artifacts, options).review((await f.reader.read(bad, anchor))!, anchor);
    assert.equal(refusals, 2); // Provider failures do not become durable historical judgments.
    assert.equal(backend.stats().review_failed, 2);
  } finally { f.close(); }
});

test('provider-wide failures remain fatal and archive completed review work', async () => {
  const f = fixture();
  try {
    const errors = [
      new ProviderApiError('deepseek', 401, 'authentication', false, null, 'invalid key'),
      new ProviderApiError('deepseek', 402, 'insufficient_balance', false, null, 'insufficient balance'),
      new ProviderApiError('deepseek', 429, 'rate_limited', true, null, 'rate limited'),
      new ProviderApiError('deepseek', 503, 'server_error', true, null, 'unavailable'),
      new ProviderApiError('deepseek', 400, 'http_error', false, 'invalid_request_error', 'invalid message format'),
      new ProviderApiError('another-provider', 400, 'http_error', false, 'invalid_request_error', 'Content Exists Risk'),
    ];
    for (const error of errors) {
      const client: LlmClient = { id: 'synthetic', async complete() { throw error; } };
      const reviewer = new EvidenceReviewer(client, f.provider, f.reader, f.artifacts);
      const backend = new QualityWebBackend(f.provider, f.reader, reviewer, f.artifacts);
      await assert.rejects(backend.search('initial', 2, anchor), RetrievalInfrastructureError);
      await assert.rejects(backend.fetch(candidateUrl, anchor), RetrievalInfrastructureError);
    }
    const artifacts = readdirSync(f.directory).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(f.directory, n), 'utf8')));
    assert.ok(artifacts.some(r => r.operation === 'search' && r.operation_error));
    assert.ok(artifacts.some(r => r.failure?.kind === 'provider-error'));
  } finally { f.close(); }
});

test('explicit four-worker candidate work is bounded and selection follows rank even when completion order reverses', { timeout: 5000 }, async () => {
  const f = fixture();
  const releases: (() => void)[] = [];
  try {
    const urls = Array.from({ length: 8 }, (_, i) => `https://synthetic.example/rank-${i}`);
    const provider: SearchProvider = { ...f.provider, async search() { return urls.map(url => ({ url, title: url })); } };
    const reader = new DocumentReader(async list => list.map((url) => page(url, `Unique content ${url} ${url.repeat(10)}`)), f.artifacts);
    let active = 0, peak = 0, started = 0;
    let fourStarted!: () => void;
    const four = new Promise<void>(resolve => { fourStarted = resolve; });
    const reviewer = { async review(doc: EvidenceDocument) {
      active++; peak = Math.max(peak, active); started++;
      if (started <= 4) await new Promise<void>(resolve => { releases.push(resolve); if (started === 4) fourStarted(); });
      active--;
      return { status: 'supported', basis: 'corroborated-content', reason: 'synthetic', evidence: [],
        receiptId: doc.id, modelCalls: 1, searchCalls: 0, readCalls: 0, costUsd: 0.001, cacheHit: false };
    } } as EvidenceReviewer;
    const backend = new QualityWebBackend(provider, reader, reviewer, f.artifacts, 0, {candidateConcurrency:4});
    const pending = backend.searchWithTrace('initial', 5, anchor);
    await four; assert.equal(started, 4);
    for (const release of [...releases].reverse()) release();
    const result = await pending;
    assert.equal(peak, 4); assert.equal(started, 5);
    assert.deepEqual(result.results.map(r => r.url), urls.slice(0, 5));
    assert.equal(result.audit!.candidates[5]!.final_disposition, 'outside_fetch_window');
    assert.equal(result.funnel!.leak_cost_usd, 0.005);
  } finally { releases.forEach(release => release()); f.close(); }
});

test('a fatal candidate with four workers waits for siblings, saves a partial audit and starts no later batch', { timeout: 5000 }, async () => {
  const f = fixture(); let release!: () => void;
  try {
    const urls = Array.from({ length: 6 }, (_, i) => `https://synthetic.example/fatal-${i}`);
    const provider: SearchProvider = { ...f.provider, async search() { return urls.map(url => ({ url, title: url })); } };
    let started = 0, siblingStarted!: () => void;
    const sibling = new Promise<void>(resolve => { siblingStarted = resolve; });
    const reviewer = { async review(doc: EvidenceDocument) {
      started++;
      if (doc.url === urls[0]) throw new RetrievalInfrastructureError('leak-filter', 'synthetic', 'synthetic failure');
      if (doc.url === urls[1]) await new Promise<void>(resolve => { release = resolve; siblingStarted(); });
      return { status: 'unknown', basis: 'unresolved', reason: 'synthetic', evidence: [], receiptId: doc.id,
        modelCalls: 1, searchCalls: 0, readCalls: 0, costUsd: 0.001, cacheHit: false };
    } } as EvidenceReviewer;
    const backend = new QualityWebBackend(provider, f.reader, reviewer, f.artifacts, 0, {candidateConcurrency:4});
    let finished = false;
    const pending = backend.search('initial', 5, anchor).finally(() => { finished = true; });
    const assertion = assert.rejects(pending, RetrievalInfrastructureError);
    await sibling; assert.equal(finished, false); release(); await assertion;
    assert.equal(started, 4);
    const artifacts = readdirSync(f.directory).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(f.directory, n), 'utf8')));
    const audit = artifacts.find(r => r.operation === 'search' && r.operation_error);
    assert.ok(audit); assert.ok(audit.candidates.every((c: any) => !c.served_to_forecaster));
    assert.equal(artifacts.filter(r => r.operation === 'candidate-review-completed').length, 4);
  } finally { release?.(); f.close(); }
});

test('single-pass review hands the model its summary unless full text is requested', () => {
  const f = fixture();
  try {
    const delivery = (opts: ConstructorParameters<typeof EvidenceReviewer>[4]) => new EvidenceReviewer(f.client, f.provider, f.reader, f.artifacts, opts).searchDelivery;
    assert.equal(delivery({ processing: 'single-pass' }), 'summary');
    assert.equal(delivery({ processing: 'single-pass', searchDelivery: 'fulltext' }), 'fulltext');
    assert.equal(delivery({ processing: 'whole-document' }), 'fulltext');
    assert.throws(() => delivery({ processing: 'whole-document', searchDelivery: 'summary' }), /single-pass/);
  } finally { f.close(); }
});
