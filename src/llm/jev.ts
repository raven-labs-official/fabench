/** Jev's typed API is a distinct, explicitly labelled closed-book harness. */
import type {LlmClient,LlmRequest,LlmCompletion,ReasoningConfiguration} from "./benchmark-client.js";
import {classifyProviderHttpError} from "./openai-compatible.js";
import {apiResource,sharedRateLimiter} from "./shared-rate-limit.js";
import {ProviderReasoningCapture} from "./reasoning-capture.js";
import {numericReference,makeJevBins,binMedian} from "./jev-bins.js";
export const JEV_MODEL="jev-1.13.0";
export const JEV_ENDPOINT="https://api.typesafe.ai/v1/systemone";
export const JEV_REVIEW_POLICY="jev-choice-2dp-099-offline-review-v1";
export const JEV_POLICY=Object.freeze({version:"jev-none-200bins-v1",event:"direct-positive-noul",
  numeric:"200-left-closed-bins;99-geometric-boundaries-per-side;1-to-500-percent;open-tails",
  point:"median-bin-midpoint;open-tail-finite-boundary;adapter-derived-not-native-median",
  rationale:"adapter-provenance-only;no-native-text-generation",input:"reviewed-messages-verbatim-in-state;typed-output-overrides-JSON-serialization-only"});
export function buildJevRequest(req:LlmRequest) {
  if(req.tools?.length || req.effort!==undefined || (req.model && req.model!==JEV_MODEL))throw new Error("Jev supports only none with pinned model and no effort/tools");
  const messages=req.messages??[{role:"system",content:req.system??""},{role:"user",content:req.prompt}];
  if(messages.length!==2 || messages[0]?.role!=="system" || messages[1]?.role!=="user")throw new Error("Jev requires one reviewed system/user forecast, without conversation history");
  const prompt=messages[1]!.content;
  const structured = prompt.startsWith("Make this forecast as someone standing at the information as-of date below.") &&
    ["\n\nInformation as-of date (UTC): ", "\nPrediction cutoff (UTC): ", "\n\nQuestion:\n", "\n\nResolution criteria:\n"].every(section=>prompt.includes(section));
  const hasBackground = prompt.includes("\n\nBackground known at the information as-of date:\n");
  // The reviewed Poly event-only prompts intentionally supply no background.
  // Accept their existing structure without synthesizing or editing any text.
  const eventOnly = prompt.includes("\n\nNumerical target:\nThis is an event-only question. Set numeric_forecast to null.\n\n");
  if(!structured || (!hasBackground && !eventOnly))throw new Error("Jev requires the reviewed historical forecast structure; numeric forecasts require supplied background");
  const reference=numericReference(prompt), bins=reference?makeJevBins(reference):[];
  const instructions="Forecast as someone standing at the information as-of date in reviewed_messages, with only the supplied basic background and information publicly available strictly before that date. Apply the stated Yes resolution criteria and target deadline. This is a future event probability, not whether the event is already confirmed at the as-of date. Preserve the historical information boundary and all substantive question requirements. The typed API replaces only JSON serialization, free-text rationale and point-value output instructions in reviewed_messages. No retrieval or later information is available.";
  const questions:Record<string,unknown>={event:{type:"noul",instructions:instructions+" What is the probability that the question's stated Yes resolution condition will be met?",criteria:{true:"The stated Yes resolution condition is met by the specified target deadline.",false:"The stated Yes resolution condition is not met."}}};
  if(reference)questions.numeric={type:"choice",instructions:instructions+" Forecast which interval contains the numerical target itself in its required unit. Return the full predictive distribution, not just the event probability. Intervals are exhaustive and mutually exclusive; impossible numeric values should receive zero probability. A boundary belongs to the interval on its right. The reference is an input-only grid center, NOT a supplied forecast or future observation.",
    criteria:Object.fromEntries(bins.map(b=>[b.key,`Target X in [${b.lower??"-infinity"}, ${b.upper??"+infinity"}) ${reference.unit}.`]))};
  return {payload:{model:JEV_MODEL,state:{reviewed_messages:messages,...(reference?{numeric_grid:{reference,formula:"deviation_percent = 100 * (X - reference.value) / reference.scale",policy:JEV_POLICY.numeric}}:{})},questions},reference,bins};
}
function probability(x:unknown):x is number{return typeof x==="number"&&Number.isFinite(x)&&x>=0&&x<=1;}
export function decodeJevResponse(raw:any, prepared:ReturnType<typeof buildJevRequest>, offlineReview?:typeof JEV_REVIEW_POLICY) {
  if(raw.model!==JEV_MODEL)throw new Error("Jev response model drift");
  if(raw.answers?.event?.type!=="noul" || !probability(raw.answers.event.noul))throw new Error("Invalid Jev event probability");
  const usage=raw.usage;
  if(!usage || !Number.isSafeInteger(usage.input_tokens)||usage.input_tokens<0||!Number.isSafeInteger(usage.output_tokens)||usage.output_tokens<0)throw new Error("Invalid Jev token usage");
  let numeric_forecast=null, derived=null;
  if(prepared.reference) {
    const answer=raw.answers.numeric, ps=answer?.probabilities;
    if(answer?.type!=="choice" || !ps || Object.keys(ps).length!==200 || prepared.bins.some(b=>!probability(ps[b.key])) || !prepared.bins.some(b=>b.key===answer.choice) || !probability(answer.confidence))throw new Error("Invalid Jev 200-bin distribution");
    const total=Object.values(ps).reduce<number>((s,p)=>s+(p as number),0);
    const rounded099=offlineReview===JEV_REVIEW_POLICY && Math.abs(total-.99)<1e-9 &&
      Object.values(ps).every(p=>Math.abs((p as number)*100-Math.round((p as number)*100))<1e-9);
    if(Math.abs(total-1)>0.001 && !rounded099)throw new Error(`Jev probability mass is ${total}, not one`);
    derived={...binMedian(prepared.bins,ps),raw_probability_sum:total};
    numeric_forecast={value:derived.value,unit:prepared.reference.unit};
  }
  return {answer:{probability_yes:raw.answers.event.noul,numeric_forecast,
    rationale:"Adapter provenance (not model reasoning): Jev returned a typed event probability. "+(derived?`Numeric value is the midpoint of median bin ${derived.bin}; open tail clipped: ${derived.tail_clipped}. `:"")+"Jev does not generate a free-text rationale."+
      (offlineReview&&derived&&Math.abs(derived.raw_probability_sum-.99)<1e-9?" Offline review accepts the raw 0.99 mass at two-decimal precision; event probability and all raw bin values are unchanged. Median is computed from relative bin weights.":"")},derived,usage};
}
export class JevClient implements LlmClient {
  readonly id=`jev:${JEV_MODEL}`;
  readonly traceMetadata={harness:JEV_POLICY.version,base_url:JEV_ENDPOINT,model:JEV_MODEL,display_condition:"jev-none",typed_adapter:JEV_POLICY,
    pricing:{known:true,usd_cost_known:true,input_per_million:0.042,output_per_million:0,source:"https://docs.typesafe.ai/models"},reasoning_visibility:"not returned by typed API"};
  constructor(private readonly key=process.env.TYPESAFE_API_KEY,private readonly transport:typeof fetch=fetch) {
    if(!key)throw new Error("TYPESAFE_API_KEY is required for Jev");
  }
  reasoningConfiguration(effort?:string):ReasoningConfiguration {
    if(effort!==undefined)throw new Error("Jev has no reasoning effort control");
    return {reasoning_mode:null,thinking_effort:null,requested_thinking_effort:null,source:"provider-default",api_parameters:{typed_adapter:JEV_POLICY,model:JEV_MODEL},history_replay:null};
  }
  async complete(req:LlmRequest):Promise<LlmCompletion> {
    const prepared=buildJevRequest(req);
    // Raw payload and response body are durable transport events. No headers or
    // credential values enter trace events, exceptions or condition metadata.
    const body=JSON.stringify(prepared.payload);
    req.onTrace?.({type:"jev_request",data:{endpoint:JEV_ENDPOINT,method:"POST",body,payload:prepared.payload,bins:prepared.bins}});
    const permit=await sharedRateLimiter()?.acquire(apiResource("jev",JEV_ENDPOINT,this.key!),req.onTrace,req.signal);
    let success=false;
    try {
      const signal=AbortSignal.any([AbortSignal.timeout(60_000),...(req.signal?[req.signal]:[]),...(permit?.signal?[permit.signal]:[])]);
      const response=await this.transport(JEV_ENDPOINT,{method:"POST",headers:{Authorization:`Bearer ${this.key}`,"Content-Type":"application/json"},body,signal});
      const rawBody=(await response.text()).replaceAll(this.key!,"[REDACTED]");
      req.onTrace?.({type:"jev_response",data:{status:response.status,body:rawBody,request_id:response.headers.get("x-request-id")}});
      if(!response.ok) {
        if(response.status===429||response.status===529)permit?.limited(response.headers.get("retry-after"));
        throw classifyProviderHttpError(this.id,response.status,rawBody);
      }
      const decoded=decodeJevResponse(JSON.parse(rawBody),prepared);
      req.onTrace?.({type:"jev_adapter_decoded",data:decoded});
      success=true;
      return {text:JSON.stringify(decoded.answer),reasoning:"",reasoningCapture:new ProviderReasoningCapture(req.onTrace).finish(true),inputTokens:decoded.usage.input_tokens,outputTokens:decoded.usage.output_tokens,
        costUsd:decoded.usage.input_tokens*0.042/1e6,provider:{model:JEV_MODEL,requestId:response.headers.get("x-request-id")??undefined},finishReason:"stop"};
    } finally {permit?.release(success);}
  }
}
