import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { PageDater } from './page-dater.js';
import { DocumentReader } from './document-reader.js';
import { EvidenceStore } from './evidence-store.js';
import { CorpusStore } from '../corpus/store.js';
import { buildFrozenIndex } from '../corpus/frozen-index.js';
import { createRetrievalSession } from '../api/session.js';

test('real Python helper keeps a long undated article, stores raw bytes, and coalesces concurrent fetches', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-http-'));
  const body = '<article><h1>Synthetic long report</h1>' + '<p>The fictional agency explains its measurement and its limitations in detail.</p>'.repeat(800) + '<table><tr><th>Unit</th><th>Value</th></tr><tr><td>points</td><td>12.5</td></tr></table><p>FINAL NOTE: provisional figures require verification.</p></article>';
  const html = `<html><body><nav>Later market widget 99.9</nav>${body}</body></html>`;
  let requests = 0;
  const server = createServer((req, res) => { requests++; res.writeHead(req.url === '/missing' ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(req.url === '/missing' ? 'Not found' : html); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/article`;
  const dater = new PageDater(false, process.env.HTMLDATE_PYTHON ?? 'python3', undefined, 15000,
    { policy: 'article-blocks-tables-v1', rawDirectory: join(directory, 'raw') });
  try {
    const [a, b] = await Promise.all([dater.fetchMany([url]), dater.fetchMany([url])]);
    assert.equal(requests, 1); assert.deepEqual(a, b);
    const page = a[0]!;
    assert.equal(page.date, null); assert.ok(page.text.length > 40000);
    assert.match(page.text, /FINAL NOTE/); assert.doesNotMatch(page.text, /99\.9/);
    assert.equal(page.content_document?.complete, true);
    assert.equal(gunzipSync(readFileSync(page.captures![0]!.path)).toString(), html);
    const reader = new DocumentReader(urls => dater.fetchMany(urls), new EvidenceStore(join(directory, 'evidence')));
    const doc = await reader.read(url, '2026-03-01T00:00:00Z');
    assert.equal(doc?.temporalBasis, 'live-page'); assert.equal(doc?.availableAt, undefined);
    const missing = url.replace('/article', '/missing');
    assert.equal(await reader.read(missing, '2026-03-01T00:00:00Z'), null);
    const missingPage = (await dater.fetchMany([missing]))[0]!;
    assert.equal(gunzipSync(readFileSync(missingPage.captures![0]!.path)).toString(), 'Not found');
  } finally {
    dater.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('quality session uses a complete historical index, immutable document IDs, and a distinct condition', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-frozen-'));
  const anchor = '2026-03-01T00:00:00Z';
  try {
    const outputs = [];
    for (const futureCount of [0, 100]) {
      const source = join(directory, `source-${futureCount}.db`), index = join(directory, `index-${futureCount}.db`);
      const store = new CorpusStore(source, 'rarity', 'write');
      store.ingest([{ url: 'https://synthetic.example/past', title: 'Orion observations', body: 'Orion observation describes atmospheric dust and the measuring instrument.', crawlDate: '2026-02-01T00:00:00Z' },
        ...Array.from({ length: futureCount }, (_, i) => ({ url: `https://synthetic.example/future/${i}`, title: 'Orion', body: 'Orion observation future result.', crawlDate: '2026-09-01T00:00:00Z' }))]);
      store.close();
      await buildFrozenIndex(source, index, anchor, { minimumFreeBytes: 0 });
      const session = createRetrievalSession({ mode: 'frozen', asOf: anchor, corpusPath: index,
        profile: 'quality-v1', evidenceDirectory: join(directory, `evidence-${futureCount}`), returnChars: 10 });
      try {
        const results = await session.search('Orion observations', 5);
        outputs.push(results);
        const first = results[0]!;
        assert.equal(results.length, 1); assert.equal(first.truncated, true);
        const tail = (await session.fetch(first.url, first.nextOffset!, 0))!;
        assert.equal(first.documentId, tail.documentId);
        assert.equal(first.snippet + tail.body, 'Orion observation describes atmospheric dust and the measuring instrument.');
        assert.equal(session.identity.profile, 'quality-v1');
      } finally { session.close(); }
    }
    assert.deepEqual(outputs[0], outputs[1]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
