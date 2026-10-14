import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {EvidenceStore,sha256} from './evidence-store.js';
import {copyArtifactGraph} from './shared-artifact-cache.js';
import type {EvidenceDocument} from './document-reader.js';

/** Explicit captured inputs for replay/reuse. This is version selection, never time admission. */
export class FixedDocumentManifest {
  readonly identity:{policy:string;sha256:string;entries:number};
  private source:EvidenceStore;private entries:{url:string;anchor:string;documentId:string}[];
  constructor(path:string){
    const value=JSON.parse(readFileSync(path,'utf8'));
    if(value.policy!=='fixed-document-input-v1'||!Array.isArray(value.entries)||typeof value.artifactDirectory!=='string')throw new Error('Invalid fixed document manifest');
    this.entries=value.entries;this.source=new EvidenceStore(resolve(dirname(path),value.artifactDirectory));
    const keys=new Set<string>();
    for(const e of this.entries){
      const u=new URL(e.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||!/^\d{4}-\d{2}-\d{2}T.+Z$/.test(e.anchor)||!Number.isFinite(Date.parse(e.anchor))||!/^[a-f0-9]{64}$/.test(e.documentId))throw new Error('Invalid fixed document entry');
      const key=JSON.stringify([e.url,new Date(e.anchor).toISOString()]);if(keys.has(key))throw new Error('Duplicate fixed document input');keys.add(key);
    }
    this.identity={policy:value.policy,sha256:sha256(JSON.stringify(this.entries)),entries:this.entries.length};
  }
  read(url:string,anchor:string,local:EvidenceStore):EvidenceDocument|null {
    const entry=this.entries.find(e=>e.url===url&&Date.parse(e.anchor)===Date.parse(anchor));if(!entry)return null;
    const d=this.source.get<Omit<EvidenceDocument,'id'>>(entry.documentId);
    if(d.url!==entry.url||d.temporalBasis!=='live-page'||d.bodySha256!==sha256(d.body)||!d.body.trim()||!d.title||!d.provenanceId)throw new Error('Invalid fixed current page');
    this.source.get(d.provenanceId);
    copyArtifactGraph(entry.documentId,this.source,local);
    return {...d,id:entry.documentId};
  }
}
