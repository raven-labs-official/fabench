/** Offline replay of an immutable capture; hashes are computed from actual backend fetches.
 * Usage: node --import tsx tools/replay-search-snapshot.ts snapshot.json output-directory
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RecordedSearchBackend, frozenSnapshotBackend, textHash, type SearchSnapshot } from '../src/retrieval/search-snapshot.js';

export async function replaySnapshot(snapshot: SearchSnapshot, out: string) {
  const recordedBackend = new RecordedSearchBackend(snapshot), index = frozenSnapshotBackend(snapshot);
  const reference=[], recorded=[], frozen=[];
  try {
    for (const [i,s] of snapshot.searches.entries()) {
      const base={query_id:String(i+1),query:s.query,as_of:snapshot.frozenAtUtc};
      const captureHashes=new Map(snapshot.pages.map(p=>[p.doc.url,p.sha256]));
      reference.push({...base,results:s.results.map(r=>({...r,content_sha256:captureHashes.get(r.url)}))});
      for (const [backend,rows] of [[recordedBackend,recorded],[index.backend,frozen]] as const) {
        const hits=await backend.search(s.query,s.requested,snapshot.frozenAtUtc);
        const results=await Promise.all(hits.map(async r=>{
          const page=await backend.fetch(r.url,snapshot.frozenAtUtc);
          return {...r,content_sha256:page ? textHash(page.body) : undefined};
        }));
        rows.push({...base,results});
      }
    }
  } finally {index.close();}
  mkdirSync(out,{recursive:true});
  for (const [name,rows] of Object.entries({reference,recorded,frozen}))
    writeFileSync(join(out,`${name}.jsonl`),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  writeFileSync(join(out,'replay-manifest.json'),JSON.stringify({schema:'raven.snapshot-replay.v1',replayed_at:new Date().toISOString(),snapshot_sha256:textHash(JSON.stringify(snapshot,null,2)+'\n'),body_hash_source:'actual backend.fetch response',network:false},null,2)+'\n');
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [input,out]=process.argv.slice(2);
  if (!input || !out) throw new Error('snapshot.json and output directory required');
  await replaySnapshot(JSON.parse(readFileSync(input,'utf8')),out);
}
