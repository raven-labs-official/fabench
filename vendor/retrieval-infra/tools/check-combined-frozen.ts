/** Compare a completed news index with its explicitly configured archive union. No model calls. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CorpusStore } from '../src/corpus/store.js';
import { corpusRetrievalIdentity } from '../src/corpus/retrieval-identity.js';
import { FrozenBackend } from '../src/retrieval/search-backend.js';
import { FrozenWithArchiveBackend, openFrozenArchive } from '../src/retrieval/frozen-with-archive.js';

const [corpusPath,archivePath,inputPath,outputPath]=process.argv.slice(2);
if(!corpusPath||!archivePath||!inputPath||!outputPath||existsSync(outputPath))throw new Error('corpus archive queries and a new output path required');
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const inputBytes=readFileSync(inputPath),queries=JSON.parse(inputBytes.toString());
if(!Array.isArray(queries)||!queries.length||queries.length>10)throw new Error('supply 1-10 diagnostic queries');
const archive=openFrozenArchive(archivePath,corpusPath,queries.map(q=>q.as_of));
const store=new CorpusStore(corpusPath),base=new FrozenBackend(store),combined=new FrozenWithArchiveBackend(base,archive.backend);
const output:any={status:'running',started_at:new Date().toISOString(),input_sha256:hash(inputBytes),
  code_sha256:Object.fromEntries(['check-combined-frozen.ts','../src/retrieval/frozen-with-archive.ts','../src/retrieval/archive-supplement.ts',
    '../src/retrieval/search-backend.ts','../src/retrieval/series-catalog.ts','../src/corpus/store.ts','../src/retrieval/snippet.ts'].map(p=>[p,hash(readFileSync(new URL(p,import.meta.url)))])),
  corpus:corpusRetrievalIdentity(corpusPath),archive:archive.identity,
  scope:'Read-only paired retrieval diagnosis. Historical source additions are not a new forecast, a prospective search baseline, or complete information sufficiency.',rows:[]};
const save=()=>writeFileSync(outputPath,JSON.stringify(output,null,2)+'\n');
save();
try {
  for(const q of queries){
    if(typeof q.query!=='string'||!Number.isInteger(q.n)||q.n<1)throw new Error('invalid query');
    const original=await base.search(q.query,q.n,q.as_of),candidate=await combined.search(q.query,q.n,q.as_of);
    if(candidate.length>q.n)throw new Error('combined result budget exceeded');
    const fetched=[];
    for(const hit of candidate){
      const doc=await combined.fetch(hit.url,q.as_of);
      if(!doc||!doc.crawlDate||Date.parse(doc.crawlDate)>=Date.parse(q.as_of))throw new Error('returned source unavailable before anchor');
      fetched.push({url:doc.url,crawl_date:doc.crawlDate,body_sha256:hash(doc.body),body_characters:doc.body.length});
    }
    const preserved=JSON.stringify(original.map(h=>h.url))===JSON.stringify(candidate.map(h=>h.url));
    if(q.required_first_url&&candidate[0]?.url!==q.required_first_url)throw new Error('required official historical source was not first');
    if(q.required_first_snippet_text&&!candidate[0]?.snippet.includes(q.required_first_snippet_text))throw new Error('dated source observation missing from first snippet');
    if(q.require_news_unchanged&&!preserved)throw new Error('news control changed');
    output.rows.push({...q,original,candidate,fetched,unchanged_url_order:preserved});save();
    console.log(JSON.stringify({id:q.id,original:original.length,combined:candidate.length,unchanged_url_order:preserved}));
  }
  output.status='complete';output.finished_at=new Date().toISOString();save();
}catch(error){output.status='failed';output.error=String(error);save();throw error;}
finally{store.close();archive.close();}
