/** Offline: select different captured URLs/bodies, pin bytes, and prepare registered-run inputs. */
import {parseArgs} from 'node:util';
import {readdirSync,readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {EvidenceStore,sha256} from '../src/retrieval/evidence-store.js';
import {copyArtifactGraph} from '../src/retrieval/shared-artifact-cache.js';
import {SINGLE_PASS_MAX_INPUT_CHARS} from '../src/retrieval/single-pass-content.js';
import type {EvidenceDocument} from '../src/retrieval/document-reader.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{out:{type:'string'},anchor:{type:'string'},count:{type:'string',default:'256'}}});
const count=Number(values.count);
if(!values.out||!values.anchor||!positionals.length||!Number.isInteger(count)||count<256||count>1024)throw new Error('Use --out DIR --anchor ISO --count 256 ARTIFACT_ROOT...');
if(!/^\d{4}-\d{2}-\d{2}T.+Z$/.test(values.anchor)||!Number.isFinite(Date.parse(values.anchor)))throw new Error('Exact anchor required');
const output=resolve(values.out),target=new EvidenceStore(join(output,'evidence'));
const urls=new Set<string>(),bodies=new Set<string>(),selected:{id:string;document_id:string;anchor:string;source:string;url:string;body_sha256:string;chars:number}[]=[];
let considered=0;
function visit(root:string){
 for(const entry of readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(selected.length>=count)return;const path=join(root,entry.name);
  if(entry.isDirectory()){visit(path);continue;}
  if(!entry.isFile()||!/^([a-f0-9]{64})\.json$/.test(entry.name))continue;
  const raw=readFileSync(path,'utf8');if(!raw.includes('"temporalBasis":"live-page"'))continue;
  const doc=JSON.parse(raw) as Omit<EvidenceDocument,'id'>;
  if(doc.temporalBasis!=='live-page'||typeof doc.body!=='string'||typeof doc.title!=='string'||!doc.url||!doc.provenanceId)continue;considered++;
  if(sha256(raw)!==entry.name.slice(0,-5)||sha256(doc.body)!==doc.bodySha256)throw new Error('Invalid captured document '+path);
  if(urls.has(doc.url)||bodies.has(doc.bodySha256)||doc.body.length<1000||doc.body.length+doc.title.length+doc.url.length>SINGLE_PASS_MAX_INPUT_CHARS)continue;
  if(!existsSync(join(root,doc.provenanceId+'.json')))continue;
  const id=entry.name.slice(0,-5);copyArtifactGraph(id,new EvidenceStore(root),target);
  urls.add(doc.url);bodies.add(doc.bodySha256);selected.push({id:`page-${String(selected.length+1).padStart(3,'0')}`,document_id:id,anchor:values.anchor!,source:path,url:doc.url,body_sha256:doc.bodySha256,chars:doc.body.length});
 }
}
positionals.forEach(root=>visit(resolve(root)));
mkdirSync(output,{recursive:true});
const save=(name:string,value:unknown)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o640});
save('selection.json',{policy:'distinct-fixed-pages-v1',considered,selected: selected.length,requested:count,ready:selected.length===count,samples:selected});
if(selected.length!==count)throw new Error(`Only ${selected.length} distinct usable captures; do not fill the sample set with copies`);
for(const concurrency of [48,64])save(`review-${concurrency}.json`,{mode:'review',evidence_directory:target.directory,content_processing:'single-pass',provider:'brave',concurrency:64,review_concurrency:concurrency,samples:selected.map(({id,document_id,anchor})=>({id,document_id,anchor}))});
save('fixed-documents.json',{policy:'fixed-document-input-v1',artifactDirectory:target.directory,entries:selected.map(s=>({url:s.url,anchor:s.anchor,documentId:s.document_id}))});
console.log(JSON.stringify({selected:selected.length,output}));
