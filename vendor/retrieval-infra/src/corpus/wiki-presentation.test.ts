import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WikipediaCache, WikiSnapshot, buildWikiIndex, chooseWikiTitle, wikiEndpoint, wikiUrlKey, withWikiPresentation } from './wikipedia-cache.js';
import { wikitextToPlain } from './wiki-text.js';

const anchor = '2026-07-01T00:00:00.000Z', host = 'https://en.wikipedia.org', target = (title: string) => ({ host, title });
const api = (id: number, pageTitle: string, body: string) => JSON.stringify({ query: { pages: [{ pageid: id, title: pageTitle, revisions: [{
  revid: id * 10, timestamp: '2026-06-15T00:00:00Z', sha1: createHash('sha1').update(body).digest('hex'),
  slots: { main: { contentmodel: 'wikitext', content: body } } }] }] } });
const alphaBody = [
  '{{Short description|Test company}}', '{{Infobox company', '| name = Alpha Corp', '| revenue = 10', '| image = x.png', '}}',
  "'''Alpha Corp''' is a policy firm in [[Beta|beta]] markets.<ref>[[Hidden reference]]</ref>",
  '== History ==', 'Founded in 2020 &ndash; still policy-focused.', '== References ==', '{{reflist}}',
].join('\n');

function fixture(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-presentation-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'wiki.sqlite'), cache = new WikipediaCache(path);
  const add = (title: string, id: number, pageTitle: string, body: string) =>
    cache.importCapture(target(title), anchor, api(id, pageTitle, body), '2026-09-01T00:00:00Z', wikiEndpoint(target(title), anchor));
  add('Alpha', 1, 'Alpha Corp', alphaBody);
  add('Alpha Corp', 1, 'Alpha Corp', alphaBody);
  add('Old Alpha', 4, 'Old Alpha', '#REDIRECT [[Alpha Corp]]');
  add('Gamma', 2, 'Renamed Gamma later', "'''Gamma''' is a policy topic.");
  add('Delta', 3, 'Totally new name', "'''{{flag|Germany}}''' Delta policy text about trade.");
  const base = cache.manifest(anchor, [target('Alpha'), target('Gamma'), target('Delta')]);
  cache.close();
  return { dir, path, base };
}

test('plain-text conversion keeps the lead, infobox fields, tables and medal counts', () => {
  const text = wikitextToPlain(alphaBody);
  assert.ok(text.startsWith('Test company\n\nAlpha Corp is a policy firm in beta markets.'));
  assert.match(text, /revenue: 10/); assert.doesNotMatch(text, /image:|Hidden reference|reflist|\{\{|References/);
  assert.match(text, /Founded in 2020 – still policy-focused\./);
  assert.equal(wikitextToPlain('{{Short description|none}}\nBody.'), 'Body.');
  const medals = wikitextToPlain('{{Medals table\n| gold_AAA = 1 | silver_AAA = 5 | bronze_AAA = 0\n| gold_BBB = 3 | silver_BBB = 0 | bronze_BBB = 2\n}}');
  assert.deepEqual(medals.split('\n'), ['BBB | gold 3 | silver 0 | bronze 2 | total 5', 'AAA | gold 1 | silver 5 | bronze 0 | total 6']);
  const table = wikitextToPlain('{| class="wikitable"\n! Year !! Winner\n|-\n| 2024 || [[Team A|A]]\n|-\n| style="x" | 2025 || B\n|}');
  assert.deepEqual(table.split('\n'), ['Year | Winner', '2024 | A', '2025 | B']);
  assert.equal(wikitextToPlain('[[File:X.png|thumb|caption [[Y]]]] Text [https://e.x Label] [[:Category:Z|cat]].'), 'Text Label cat.');
});

test('titles shown to the model need pre-anchor evidence', () => {
  assert.deepEqual(chooseWikiTitle('Alpha Corp', "'''Alpha Corp''' is", 'Alpha Corp'), { title: 'Alpha Corp', source: 'page-title-in-text' });
  assert.deepEqual(chooseWikiTitle('Scott Brown (politician)', "'''Scott Philip Brown''' ... Scott Brown served", 'Scott Philip Brown'),
    { title: 'Scott Brown (politician)', source: 'page-title-base-in-text' });
  assert.deepEqual(chooseWikiTitle('Renamed later', "'''Gamma''' topic", 'Gamma'), { title: 'Gamma', source: 'lead-bold' });
  assert.equal(chooseWikiTitle('New name', "'''{{flag|Germany}}''' Delta policy text.", '{{flag|Germany}}').source, 'lead-text');
});

test('ordinary article addresses map to one lookup key', () => {
  const key = wikiUrlKey(`${host}/wiki/Alpha_Corp`);
  for (const url of [`${host}/wiki/alpha_Corp#History`, 'https://en.m.wikipedia.org/wiki/Alpha%20Corp', `${host}/w/index.php?title=Alpha_Corp`])
    assert.equal(wikiUrlKey(url), key);
  assert.equal(wikiUrlKey(`${host}/w/index.php?oldid=10`), null);
  assert.equal(wikiUrlKey('https://example.com/wiki/Alpha'), null);
});

test('the original manifest keeps wikitext, old titles and exact-address fetches only', t => {
  const f = fixture(t), cache = new WikipediaCache(f.path, true), snap = new WikiSnapshot(cache, f.base);
  t.after(() => { snap.close(); cache.close(); });
  assert.equal(snap.getByUrlBefore(`${host}/wiki/Alpha`, anchor), null);
  const hit = snap.searchRaw('policy', anchor, 10).find(d => d.url.endsWith('oldid=10'))!;
  assert.match(hit.body, /^\{\{Short description/); assert.equal(hit.title, 'Alpha Corp');
});

test('a presentation manifest ranks the original text but shows plain text, evidenced titles and opens pinned pages by title', t => {
  const f = fixture(t), cache = new WikipediaCache(f.path, true);
  const { manifest, report } = withWikiPresentation(cache, f.base);
  assert.deepEqual(report.titleSources, { 'page-title-in-text': 1, 'lead-bold': 1, 'lead-text': 1 });
  const alpha = manifest.revisions.find(r => r.version === '10')!;
  assert.ok(alpha.aliases!.includes('Old Alpha') && alpha.aliases!.includes('Alpha'));
  assert.equal(manifest.revisions.find(r => r.version === '20')!.title, 'Gamma');
  const snap = new WikiSnapshot(cache, manifest), old = new WikiSnapshot(cache, f.base);
  t.after(() => { snap.close(); old.close(); cache.close(); });
  assert.notEqual(snap.identity.sha256, old.identity.sha256);
  // Search and ranking see the original wikitext under the evidenced title; the model reads plain text.
  const hit = snap.searchRaw('policy', anchor, 10).find(d => d.url.endsWith('oldid=10'))!;
  assert.ok(hit.body.startsWith('{{Short description')); assert.equal(hit.title, 'Alpha Corp');
  assert.ok(snap.present(hit).body.startsWith('Test company')); assert.equal(snap.present(hit).title, 'Alpha Corp');
  assert.ok(snap.searchRaw('hidden', anchor, 10).length);
  assert.deepEqual(snap.searchRaw('hidden', anchor, 10).map(d => d.url), old.searchRaw('hidden', anchor, 10).map(d => d.url));
  const news = { url: 'https://news.test/a', title: 'News', body: '{{not wiki}}', crawlDate: anchor, score: 0 } as never;
  assert.equal(snap.present(news), news); assert.equal(old.present(hit), hit);
  for (const url of [`${host}/wiki/Old_Alpha`, 'https://en.m.wikipedia.org/wiki/alpha_Corp#History', `${host}/w/index.php?title=Alpha`])
    assert.equal(snap.getByUrlBefore(url, anchor)?.url, `${host}/w/index.php?oldid=10`);
  assert.ok(snap.getByUrlBefore(`${host}/wiki/Old_Alpha`, anchor)!.body.startsWith('Test company'));
  assert.equal(snap.getByUrlBefore(`${host}/wiki/Unknown_page`, anchor), null);

  // The disk index serves the same presentation as the in-memory snapshot.
  const file = join(f.dir, 'index.sqlite');
  buildWikiIndex(cache, manifest, file, { minFreeBytes: 0 });
  const disk = new WikiSnapshot(cache, manifest, file);
  t.after(() => disk.close());
  assert.deepEqual(disk.searchRaw('policy', anchor, 10).map(d => [d.url, d.title, d.body]), snap.searchRaw('policy', anchor, 10).map(d => [d.url, d.title, d.body]));
  assert.equal(disk.getByUrlBefore(`${host}/wiki/Old_Alpha`, anchor)?.title, 'Alpha Corp');
});

test('a read-only cache opened during a write waits for the writer instead of failing', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-busy-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'wiki.sqlite');
  new WikipediaCache(path).close();
  // Exclusive locking mode keeps every other connection out until the child commits.
  const code = `import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;');
    console.log('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    db.exec('COMMIT'); db.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.on('exit', resolve));
  await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
  const reader = new WikipediaCache(path, true);
  reader.close();
  assert.equal(await exited, 0);
});
