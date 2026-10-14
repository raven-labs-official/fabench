/** Prospective capture. The anchor is the END of the observation window, never backdated.
 * Usage: node --import tsx tools/capture-search-baseline.ts queries.json output-directory
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSearchProvider, SerperProvider } from '../src/retrieval/search-providers.js';
import { PageDater } from '../src/retrieval/page-dater.js';
import { textHash, type SearchSnapshot } from '../src/retrieval/search-snapshot.js';
import { replaySnapshot } from './replay-search-snapshot.js';

const [queriesPath, out] = process.argv.slice(2);
if (!queriesPath || !out) throw new Error('queries.json and output directory required');
if (existsSync(join(out,"snapshot.json"))) throw new Error("completed snapshot already exists");
mkdirSync(out, { recursive: true, mode: 0o2775 });
const queries: string[] = JSON.parse(readFileSync(queriesPath, 'utf8'));
if (!Array.isArray(queries) || !queries.length || queries.length > 10 || queries.some(q=>typeof q!=='string' || !q.trim()) || new Set(queries).size !== queries.length) throw new Error('supply 1–10 distinct nonempty queries');
const protocolPath=join(out,'capture-input.json');
const input={queries,width:5,provider:'serper',capture_format:'normalized-results-and-provider-json-v2',
  locale_policy:'No gl/hl override; requested parameters and returned searchParameters are preserved',
  code_sha256:Object.fromEntries(['./capture-search-baseline.ts','./date-and-text.py','../src/retrieval/page-dater.ts','../src/retrieval/search-providers.ts'].map(path=>
    [path,textHash(readFileSync(new URL(path,import.meta.url),'utf8'))]))};
if (existsSync(protocolPath) && JSON.stringify(JSON.parse(readFileSync(protocolPath,'utf8')))!==JSON.stringify(input)) throw new Error('resume input differs from the saved capture protocol');
if (!existsSync(protocolPath)) writeFileSync(protocolPath,JSON.stringify(input,null,2)+'\n',{flag:'wx'});
const provider = createSearchProvider('serper');
if (!(provider instanceof SerperProvider)) throw new Error('raw search capture requires the Serper provider');
const dater = new PageDater(false); // direct fetch; failures are measured, never fabricated
const snapshot: SearchSnapshot = existsSync(join(out,'capture.partial.json')) ? JSON.parse(readFileSync(join(out,'capture.partial.json'),'utf8')) : { schema: 'raven.search-snapshot.v1', startedAtUtc:new Date().toISOString(),frozenAtUtc:'',provider:provider.name,searches:[],pages:[],fetchFailures:[] };
const width = 5;
if (snapshot.schema!=='raven.search-snapshot.v1' || snapshot.provider!==provider.name || snapshot.frozenAtUtc || snapshot.searches.some(s=>!queries.includes(s.query) || s.requested!==width)) throw new Error('partial capture does not match this request');
try {
  for (const query of queries) {
    if (snapshot.searches.some(s=>s.query===query)) continue;
    const {results,capture} = await provider.searchWithCapture(query,width);
    snapshot.searches.push({query,requested:width,observedAtUtc:capture.observedAtUtc,providerCapture:capture,
      results:results.map(r=>({...r,snippet:r.snippet??'',source:'web'}))});
    console.log(`live capture ${snapshot.searches.length}/${queries.length}, ${results.length} results`);
    writeFileSync(join(out,'capture.partial.json'),JSON.stringify(snapshot,null,2)+'\n');
  }
  for (const url of new Set(snapshot.searches.flatMap(s=>s.results.map(r=>r.url)))) {
    if (snapshot.pages.some(p=>p.doc.url===url) || snapshot.fetchFailures.some(p=>p.url===url)) continue;
    const [p] = await dater.fetchMany([url]);
    if (p?.text?.trim() && !/^HTTP [45]/.test(p.why)) snapshot.pages.push({ observedAtUtc:new Date().toISOString(),sha256:textHash(p.text),doc:{url,title:p.title,body:p.text,source:'web',publishDate:p.date??undefined} });
    else snapshot.fetchFailures.push({url,reason:p?.why??'no response'});
    writeFileSync(join(out,'capture.partial.json'),JSON.stringify(snapshot,null,2)+'\n');
  }
  snapshot.frozenAtUtc = new Date().toISOString();
  writeFileSync(join(out,'snapshot.json'),JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'});
  await replaySnapshot(snapshot,out);
  writeFileSync(join(out,'manifest.json'),JSON.stringify({schema:'raven.capture-manifest.v1',snapshot_sha256:textHash(JSON.stringify(snapshot,null,2)+'\n'),started_at:snapshot.startedAtUtc,frozen_at:snapshot.frozenAtUtc,provider_stats:provider.stats(),page_count:snapshot.pages.length,fetch_failures:snapshot.fetchFailures.length,purpose:'prospective instrument validation; not historical Aug30 reconstruction'},null,2)+'\n');
  console.log(`captured ${snapshot.pages.length} pages, ${snapshot.fetchFailures.length} failures; anchor ${snapshot.frozenAtUtc}`);
} finally { dater.close(); }
