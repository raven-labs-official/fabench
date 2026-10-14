/** Explicit, immutable source-publication policy. A recorded issue date is not a historical capture. */
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {sha256} from './evidence-store.js';
import type {EvidenceDocument} from './document-reader.js';
export type SourceFile = {path:string;sha256:string};
export type RegisteredSource={url:string;title:string;bodySha256:string;availableAt:string;version:string;sourceType:'financial-report';referenceUrl:string;timeEvidence:string;
  publisher?:string;reportingPeriod?:string;aliases?:string[];supersedes?:string;acquiredAt?:string;cachedAt?:string;
  bodyFile?:SourceFile;originalFile?:SourceFile;publicationEvidence?:SourceFile;checkedBy?:string;checkedAt?:string};
const hash = (s:unknown):s is string => typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const https = (s:unknown):s is string => {try{const u=new URL(String(s));return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
const time = (s:unknown):s is string => typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T.+Z$/.test(s)&&Number.isFinite(Date.parse(s));
export class SourceManifest {
  readonly identity:{policy:string;sha256:string;entries:number};
  private entries:RegisteredSource[];
  private base:string;
  constructor(path:string){
    this.base=dirname(resolve(path));
    const raw=readFileSync(path,'utf8');const value=JSON.parse(raw);
    if(!['registered-source-publication-v1','registered-source-publication-v2'].includes(value.policy)||!Array.isArray(value.entries))throw new Error('Invalid source publication manifest');
    this.entries=value.entries;
    const keys=new Set<string>();
    for(const e of this.entries){
      if(e.sourceType!=='financial-report'||!e.title?.trim()||!/^https:\/\//.test(e.url)||!/^https:\/\//.test(e.referenceUrl)||!/^[a-f0-9]{64}$/.test(e.bodySha256)||!e.version?.trim()||!e.timeEvidence?.trim()||!/^\d{4}-\d{2}-\d{2}T.+Z$/.test(e.availableAt)||!Number.isFinite(Date.parse(e.availableAt)))throw new Error('Source entry needs exact title, document hash, version, issue time and reference');
      const key=e.url+'|'+e.bodySha256;if(keys.has(key))throw new Error('Duplicate registered source version');keys.add(key);
      if(e.aliases&&(!Array.isArray(e.aliases)||e.aliases.some(u=>!https(u))||new Set(e.aliases).size!==e.aliases.length))throw new Error('Invalid verified source aliases');
      if(value.policy==='registered-source-publication-v2'){
        if(!e.publisher?.trim()||!e.reportingPeriod?.trim()||!e.checkedBy?.trim()||!time(e.checkedAt)||!time(e.acquiredAt)||!time(e.cachedAt)||Date.parse(e.cachedAt)<Date.parse(e.acquiredAt)||Date.parse(e.checkedAt)<Date.parse(e.acquiredAt))throw new Error('Source version needs publisher, reporting period, acquisition, cache and review record');
        for(const f of [e.bodyFile,e.originalFile,e.publicationEvidence])if(!f||!f.path?.trim()||!hash(f.sha256))throw new Error('Source version requires hashed original, body and publication evidence');
        if(e.bodyFile!.sha256!==e.bodySha256)throw new Error('Source body file identity mismatch');
      }
    }
    // A URL/time pair must identify one revision, including aliases. Corrections need a new time/version.
    const versions=new Map<string,string>();
    for(const e of this.entries)for(const url of [e.url,...e.aliases??[]]){
      const key=JSON.stringify([url,new Date(e.availableAt).toISOString()]);const prior=versions.get(key);
      if(prior&&prior!==e.bodySha256)throw new Error('Ambiguous source version at the same publication time');versions.set(key,e.bodySha256);
    }
    this.identity={policy:value.policy,sha256:sha256(raw),entries:this.entries.length};
  }
  match(doc:EvidenceDocument){return this.entries.find(e=>(e.url===doc.url||e.aliases?.includes(doc.url))&&e.title===doc.title&&e.bodySha256===doc.bodySha256);}
  private file(f:SourceFile):Buffer {
    const bytes=readFileSync(resolve(this.base,f.path));
    if(sha256(bytes)!==f.sha256)throw new Error('Registered source cache hash mismatch');
    return bytes;
  }
  /** Only an explicit manifest pins a current URL to an audited historical version. */
  read(url:string,anchor:string,artifacts:import('./evidence-store.js').EvidenceStore):EvidenceDocument|null {
    if(!Number.isFinite(Date.parse(anchor)))throw new Error('Invalid source anchor');
    const e=this.entries.filter(e=>(e.url===url||e.aliases?.includes(url))&&e.bodyFile&&Date.parse(e.availableAt)<Date.parse(anchor))
      .sort((a,b)=>Date.parse(b.availableAt)-Date.parse(a.availableAt))[0];
    if(!e)return null;
    const body=new TextDecoder('utf-8',{fatal:true}).decode(this.file(e.bodyFile!));
    if(!body.trim()||sha256(body)!==e.bodySha256)throw new Error('Registered source body mismatch');
    const original=e.originalFile?this.file(e.originalFile):undefined;
    const evidence=e.publicationEvidence?this.file(e.publicationEvidence):undefined;
    const provenanceId=artifacts.put({source:'registered-publication',manifest:this.identity,entry:e,requestedUrl:url,
      originalId:original?artifacts.put({encoding:'base64',bytes:original.toString('base64'),sha256:e.originalFile!.sha256}):null,
      publicationEvidenceId:evidence?artifacts.put({encoding:'base64',bytes:evidence.toString('base64'),sha256:e.publicationEvidence!.sha256}):null});
    const doc:Omit<EvidenceDocument,'id'>={url:e.url,title:e.title,body,bodySha256:e.bodySha256,acquiredAt:e.acquiredAt??e.availableAt,
      publishedDate:e.availableAt,temporalBasis:'registered-source',availableAt:e.availableAt,version:e.version,provenanceId};
    return {...doc,id:artifacts.put(doc)};
  }
}
