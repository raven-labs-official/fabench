/** Evidence retrieval for the content processor. These results never enter forecast tools. */
import type {ToolCall, ToolSpec} from '../llm/client.js';
import type {DocumentReader} from './document-reader.js';
import type {SearchProvider} from './search-providers.js';
import {EvidenceStore} from './evidence-store.js';

export const BOUNDED_RESEARCH_POLICY = Object.freeze({version:'bounded-time-research-v1',maxModelCalls:3,maxSearchCalls:2,maxReadCalls:3,searchResults:5,readChars:12000});
export const TIME_RESEARCH_TOOLS: ToolSpec[] = [
  {name:'search_evidence',description:'Search for evidence of when a specific statement, report or revision became public. Results may be later than the cutoff and are private to this review. Read relevant sources to verify uncertain snippets.',parameters:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}},
  {name:'read_evidence',description:'Read a URL returned by search_evidence or the candidate URL. Optional literal find locates a relevant passage in a long document; otherwise read from offset (default 0). Text is unreviewed evidence, not a historical guarantee.',parameters:{type:'object',properties:{url:{type:'string'},find:{type:'string'},offset:{type:'integer',minimum:0}},required:['url'],additionalProperties:false}},
];
export class BoundedResearch {
  searchCalls=0; readCalls=0;
  readonly visible = new Map<string, Record<string,unknown>>();
  private allowed: Set<string>;
  private searches = new Map<string,Promise<unknown>>();
  private reads = new Map<string,Promise<unknown>>();
  constructor(private provider:SearchProvider,private reader:DocumentReader,private artifacts:EvidenceStore,private candidateId:string,private anchor:string,candidateUrl:string){this.allowed=new Set([candidateUrl]);}
  async execute(call:ToolCall):Promise<unknown>{
    const startedAtUtc=new Date().toISOString(),start=performance.now();let result:unknown;
    try{result=await this.run(call);return result;}
    finally{this.artifacts.put({operation:'time-research-tool',candidateId:this.candidateId,anchor:this.anchor,call,startedAtUtc,finishedAtUtc:new Date().toISOString(),durationMs:performance.now()-start,result:result??{error:'request failed; see provider/reader trace'}});}
  }
  private async run(call:ToolCall):Promise<unknown>{
    if(call.name==='search_evidence'){
      const query=typeof call.args.query==='string'?call.args.query.trim():'';
      if(!query||query.length>400||query.split(/\s+/).length>50)return {error:'query must contain 1–400 characters and at most 50 words'};
      const cached=this.searches.get(query);if(cached)return cached;
      if(this.searchCalls>=BOUNDED_RESEARCH_POLICY.maxSearchCalls)return {error:'search budget exhausted'};
      this.searchCalls++;
      const pending=this.provider.search(query,BOUNDED_RESEARCH_POLICY.searchResults).then(hits=>hits.map(hit=>{
        this.allowed.add(hit.url);
        const source={scope:'search-metadata',...hit,observedAtUtc:new Date().toISOString()};
        const artifactId=this.artifacts.put({operation:'time-research-source',candidateId:this.candidateId,query,source});
        const sourceId=`e${this.visible.size+1}`,record={artifactId,...source};this.visible.set(sourceId,record);
        return {sourceId,...record};
      }));this.searches.set(query,pending);return pending;
    }
    if(call.name==='read_evidence'){
      const {url,find}=call.args,offset=call.args.offset??0;
      if(typeof url!=='string'||!this.allowed.has(url))return {error:'URL must come from search_evidence or be the candidate URL'};
      if(!Number.isSafeInteger(offset)||Number(offset)<0||(find!==undefined&&(typeof find!=='string'||!find.trim()||find.length>500)))return {error:'invalid offset or literal find'};
      const key=JSON.stringify([url,offset,find]);const cached=this.reads.get(key);if(cached)return cached;
      if(this.readCalls>=BOUNDED_RESEARCH_POLICY.maxReadCalls)return {error:'read budget exhausted'};
      this.readCalls++;
      const pending=this.reader.read(url,this.anchor).then(doc=>{
        if(!doc)return {error:'source article unavailable',url};
        let start=Number(offset);
        if(typeof find==='string'){
          const position=doc.body.toLowerCase().indexOf(find.toLowerCase());
          if(position<0)return {error:'literal phrase not found',url,totalChars:doc.body.length};
          start=Math.max(0,position-1200);
        }
        const text=doc.body.slice(start,start+BOUNDED_RESEARCH_POLICY.readChars);
        if(!text)return {error:'offset is beyond source text',url,totalChars:doc.body.length};
        const source={scope:'source-passage',documentId:doc.id,url:doc.url,title:doc.title,publishedDate:doc.publishedDate,availableAt:doc.availableAt,temporalBasis:doc.temporalBasis,acquiredAt:doc.acquiredAt,offset:start,end:start+text.length,totalChars:doc.body.length,complete:start===0&&text.length===doc.body.length,text};
        const artifactId=this.artifacts.put({operation:'time-research-source',candidateId:this.candidateId,source});
        const sourceId=`e${this.visible.size+1}`,record={artifactId,...source};this.visible.set(sourceId,record);return {sourceId,...record};
      });this.reads.set(key,pending);return pending;
    }
    return {error:'unknown research tool'};
  }
  references(ids:unknown){
    return validateResearchReferences(this.visible,ids);
  }
}

export function validateResearchReferences(visible:ReadonlyMap<string,Record<string,unknown>>,ids:unknown){
  if(ids===undefined)return [];
  if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!visible.has(id)))throw new Error('Evidence IDs must refer to results actually returned to this review');
  return [...new Set(ids as string[])].map(sourceId=>({sourceId,scope:String(visible.get(sourceId)!.scope),...(typeof visible.get(sourceId)!.artifactId==='string'?{artifactId:visible.get(sourceId)!.artifactId as string}:{})}));
}
