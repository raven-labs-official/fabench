/** Diagnostic retrieval of verified WARC-derived supplements; never mutates the base corpus. */
import { readFileSync,writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CorpusStore } from '../src/corpus/store.js';
import { FrozenBackend } from '../src/retrieval/search-backend.js';
import { ArchiveSupplementBackend } from '../src/retrieval/archive-supplement.js';
const [corpus,input,queriesPath,output]=process.argv.slice(2);
if(!corpus||!input||!queriesPath||!output)throw new Error('base corpus, supplement JSONL, saved query JSON, output required');
const docs=readFileSync(input,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
for(const d of docs)if(d.source!=='cc-main'||d.capture_proof?.text_sha256!==hash(d.body)||!d.capture_proof?.warc_record_id)throw new Error('verified CC capture proof with matching text hash required');
const queries=JSON.parse(readFileSync(queriesPath,'utf8'));
if(!queries.length)throw new Error('at least one query required');
const base=new CorpusStore(corpus),supplement=new ArchiveSupplementBackend(docs,queries[0].as_of);
try {
 const baseline=new FrozenBackend(base);
 const results=[];
 for(const q of queries){
  if(docs.some(d=>Date.parse(d.crawlDate)>=Date.parse(q.as_of)))throw new Error('supplement contains a capture at/after the anchor');
  const original=await baseline.search(q.query,10,q.as_of),additional=await supplement.search(q.query,10,q.as_of);
  const fetched=[];
  for(const h of additional){const d=await supplement.fetch(h.url,q.as_of);if(d)fetched.push({url:d.url,crawlDate:d.crawlDate,chars:d.body.length,body_sha256:hash(d.body)});}
  results.push({query:q.query,as_of:q.as_of,original,additional,fetched});
 }
 writeFileSync(output,JSON.stringify({scope:'verified capture pool diagnostic with exact series-id routing; no main corpus modification or forecasting calls',supplement_sha256:hash(readFileSync(input,'utf8')),stats:supplement.stats(),results},null,2)+'\n');
 console.log(JSON.stringify(results.map(r=>({query:r.query,original:r.original.length,additional:r.additional.length,fetched:r.fetched.length}))));
} finally {base.close();supplement.close();}
