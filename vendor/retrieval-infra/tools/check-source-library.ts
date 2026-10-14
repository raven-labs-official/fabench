import {SourceManifest} from '../src/retrieval/source-manifest.js';
import {DocumentReader} from '../src/retrieval/document-reader.js';
import {EvidenceReviewer} from '../src/retrieval/evidence-reviewer.js';
import {EvidenceStore} from '../src/retrieval/evidence-store.js';
import {writeFileSync} from 'node:fs';
const [manifest,url,anchor,directory,out]=process.argv.slice(2);
if(!manifest||!url||!anchor||!directory||!out)throw new Error('Usage: check-source-library.ts MANIFEST URL ANCHOR EVIDENCE_DIRECTORY REPORT');
let network=0,models=0;
const artifacts=new EvidenceStore(directory),sources=new SourceManifest(manifest);
const reader=new DocumentReader(async()=>{network++;throw new Error('Source manifest did not satisfy offline read');},artifacts,undefined,undefined,undefined,undefined,sources);
const reviewer=new EvidenceReviewer({id:'offline-source-check',complete:async()=>{models++;throw new Error('Source requires model review');}},
 {name:'offline-source-check',stats:()=>({requests:0,failed:0}),search:async()=>{network++;throw new Error('Unexpected network');}},reader,artifacts,{processing:'single-pass',sourceManifestFile:manifest});
try{
 const doc=await reader.read(url,anchor);if(!doc)throw new Error('No registered pre-anchor source');
 const result=await reviewer.review(doc,anchor);
 writeFileSync(out,JSON.stringify({sourceManifest:sources.identity,pid:process.pid,documentId:doc.id,bodySha256:doc.bodySha256,chars:doc.body.length,network,models,...result},null,2)+'\n',{flag:'wx',mode:0o640});
 if(result.status!=='supported'||models||network)throw new Error('Offline source validation failed');
 console.log(JSON.stringify({status:result.status,chars:doc.body.length,network,models}));
}finally{reviewer.close();}
