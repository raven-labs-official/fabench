import {createHash} from "node:crypto";
import type {LlmTraceEvent} from "./client.js";

export const REASONING_RETENTION_POLICY = "raven.provider-reasoning.v1";
export interface ReasoningCaptureMetadata {
  policy: typeof REASONING_RETENTION_POLICY;
  status: "text_returned" | "artifact_only" | "empty" | "not_returned";
  native_fields: string[];
  native_frames: number;
  native_trace_enabled: boolean;
  readable_source: string | null;
  readable_chars: number;
  readable_sha256: string;
  stream_complete: boolean;
}

const REASONING_KEY=/reasoning|thinking|thought/i;
const reasoningKeys=new Map<string,boolean>();
function isReasoningKey(key:string):boolean {
  let known=reasoningKeys.get(key);
  if(known===undefined) {known=REASONING_KEY.test(key);if(reasoningKeys.size<256)reasoningKeys.set(key,known);}
  return known;
}

/** Preserve provider-exposed reasoning, including opaque blocks, without guessing hidden CoT. */
export class ProviderReasoningCapture {
  private fields=new Set<string>();
  private readable=new Map<string,string>();
  private pending: {frame:number;fields:Record<string,unknown>}[]=[];
  private pendingChars=0;
  private count=0;
  private nonemptyArtifact=false;
  constructor(private readonly onTrace?: (event:LlmTraceEvent)=>void) {}

  observe(delta: Record<string,unknown>): void {
    // Called once per streamed token, so it avoids per-call entry arrays, repeated regex tests
    // and serializing every frame just to measure it.
    let fields: Record<string,unknown>|undefined;
    let chars=0;
    for(const key of Object.keys(delta)) {
      const value=delta[key];
      if(value===null || value===undefined || !isReasoningKey(key)) continue;
      (fields??={})[key]=value;this.fields.add(key);
      if(typeof value==="string") {
        if(key==="reasoning_content" || key==="reasoning" || key==="thinking")
          this.readable.set(key,(this.readable.get(key)??"")+value);
        chars+=key.length+value.length+6;
      } else chars+=key.length+JSON.stringify(value).length+4;
    }
    if(Array.isArray(delta.content)) {
      const blocks=delta.content.filter(x=>x && typeof x==="object" && /reasoning|thinking|thought/i.test(String(x.type??"")));
      if(blocks.length) {(fields??={}).content=blocks;this.fields.add("content.reasoning_blocks");chars+=JSON.stringify(blocks).length+10;}
    }
    if(!fields) return;
    this.nonemptyArtifact ||= Object.values(fields).some(v=>typeof v==="string"?!!v.trim():Array.isArray(v)?v.length>0:!!v);
    this.count++;
    if(this.onTrace) {
      this.pending.push({frame:this.count,fields});
      // Bound unflushed text (about 16K characters; the count ignores JSON escapes) while
      // avoiding one fsync per model token. Never truncate a frame.
      this.pendingChars+=chars;
      if(this.pendingChars>=16_384) this.flush();
    }
  }

  private flush() {
    if(!this.pending.length) return;
    this.onTrace?.({type:"provider_reasoning_frames",data:{policy:REASONING_RETENTION_POLICY,frames:this.pending}});
    this.pending=[];this.pendingChars=0;
  }
  private source(): string|null {
    return ["reasoning_content","reasoning","thinking"].find(k=>!!this.readable.get(k)?.trim())??null;
  }
  get text(): string {
    const source=this.source();
    return source?this.readable.get(source)!:(this.readable.get("reasoning_content")??"");
  }
  finish(streamComplete: boolean): ReasoningCaptureMetadata {
    this.flush();
    const text=this.text;
    const metadata: ReasoningCaptureMetadata={policy:REASONING_RETENTION_POLICY,
      status:text.trim()?"text_returned":this.nonemptyArtifact?"artifact_only":this.count?"empty":"not_returned",
      native_fields:[...this.fields].sort(),native_frames:this.count,native_trace_enabled:!!this.onTrace,
      readable_source:this.source(),readable_chars:text.length,
      readable_sha256:createHash("sha256").update(text).digest("hex"),stream_complete:streamComplete};
    this.onTrace?.({type:"provider_reasoning_capture",data:metadata});
    return metadata;
  }
}
