import test from "node:test";
import assert from "node:assert/strict";
import {numericReference,makeJevBins,binMedian} from "./jev-bins.js";
import {buildJevRequest,decodeJevResponse,JevClient,JEV_MODEL,JEV_REVIEW_POLICY} from "./jev.js";
import {reviewedJevForecast,repairRawFinal} from "../experiments/repair-forecast-run.js";
import {sha256} from "../tracing/trace-archive.js";
import {parseForecastResponse} from "../predictors/forecast-response.js";
import {formalArguments} from "../experiments/environment-check.js";
import {PKG_ROOT} from "../paths.js";
import {AgenticSearchPredictor} from "../predictors/agentic-search.js";
import {NullRetrievalEnv} from "../predictors/types.js";
const prompt=(title:string,unit:string|null,measure="Revenue",background="A permitted basic background.")=>
  "Make this forecast as someone standing at the information as-of date below.\n\nInformation as-of date (UTC): 2026-07-01T00:00:00Z\nPrediction cutoff (UTC): 2026-09-01T00:00:00Z\n\nQuestion:\n"+title+
  "\n\nBackground known at the information as-of date:\n"+background+"\n\nResolution criteria:\nResolve Yes if the stated threshold is exceeded.\n\nNumerical target:\n"+
  (unit?`Forecast this measure: ${measure}\nRequired unit: ${unit}\nPoint forecast: predictive median.`:"This is an event-only question. Set numeric_forecast to null.")+"\n\nReturn one JSON object with exactly these three keys: probability_yes, numeric_forecast, rationale.";
const example=prompt("Will revenue exceed $100 billion?","USD_billion");
const request={system:"Reviewed system",prompt:example};
function response(prepared=buildJevRequest(request),idx=100) {
  return {model:JEV_MODEL,answers:{event:{type:"noul",noul:0.37},...(prepared.reference?{numeric:{type:"choice",choice:prepared.bins[idx]!.key,confidence:1,
    probabilities:Object.fromEntries(prepared.bins.map((b,i)=>[b.key,i===idx?1:0]))}}:{})},usage:{input_tokens:1000,output_tokens:250}};
}
test("200 bins are exhaustive, ordered, half-open and exactly reach +/-1% and +/-500%",()=>{
  const ref=numericReference(example)!, bins=makeJevBins(ref);
  assert.equal(bins.length,200);assert.equal(new Set(bins.map(b=>b.key)).size,200);
  assert.equal(bins[0]!.lower,null);assert.equal(bins[0]!.upper,-400);
  assert.equal(bins[199]!.lower,600);assert.equal(bins[199]!.upper,null);
  assert.deepEqual([bins[99]!.lower,bins[99]!.upper,bins[100]!.lower,bins[100]!.upper],[99,100,100,101]);
  for(let i=1;i<200;i++){assert.equal(bins[i-1]!.upper,bins[i]!.lower);if(i<199)assert.ok(bins[i]!.upper!>bins[i]!.lower!);}
  assert.equal(binMedian(bins,response().answers.numeric!.probabilities).value,100.5);
  assert.equal(binMedian(bins,response(buildJevRequest(request),0).answers.numeric!.probabilities).tail_clipped,true);
});
test("numeric references preserve signs and explicit target-unit conversions",()=>{
  const cases:[string,string,number][]=[
    ["Will Boeing EPS exceed the Q2 2025 value of -$0.92?","USD_per_share",-0.92],
    ["Will fees be above $2.35 billion?","USD",2.35e9],
    ["Will employment be greater than +172,000?","thousand_jobs",172],
    ["Will openings exceed 7,594,000, the level first published?","thousand_job_openings",7594],
    ["Will starts exceed a seasonally adjusted annual rate of 580,000, the prior rate?","thousand_units_annual_rate",580],
    ["Will sales exceed a seasonally adjusted annual rate of 4.17 million, the prior rate?","million_units_annual_rate",4.17],
    ["Will temperature exceed the 16.8°C observed before?","degrees_Celsius",16.8],
    ["Will revenue exceed NT$416.975 billion?","TWD_billion",416.975],
    ["Will the finish be more than 4 minutes 24 seconds ahead?","seconds",264],
    ["Will the score be better than 12 under par?","strokes relative to par",-12],
  ];
  for(const [q,u,value] of cases)assert.equal(numericReference(prompt(q,u))!.value,value,q);
  const fed=numericReference(prompt("Will the rate be 3.50%–3.75%?","percent","Upper bound of the federal funds target range"));
  assert.equal(fed!.value,3.75);
  const f1=numericReference(prompt("Will Kimi lead?","points","Kimi points minus the highest points total of any other driver","Kimi led the Drivers' Championship by 40 points."));
  assert.equal(f1!.value,40);
  const zero=numericReference(prompt("Will rainfall be as above the 1961–1990 average?","percent_departure_from_1961_1990_average"))!;
  assert.equal(zero.value,0);assert.equal(zero.scale,100);assert.equal(makeJevBins(zero)[100]!.upper,1);
  assert.throws(()=>numericReference(prompt("Unknown numeric target","USD")),/No unambiguous/);
});
test("typed payload preserves exact reviewed messages and event-only prompts omit numeric choices",()=>{
  const built=buildJevRequest(request);
  assert.equal(built.payload.state.reviewed_messages[1]!.content,example);
  assert.equal(Object.keys((built.payload.questions.numeric as any).criteria).length,200);
  const event=buildJevRequest({system:"Reviewed system",prompt:prompt("Will an event occur?",null)});
  assert.deepEqual(Object.keys(event.payload.questions),["event"]);
  assert.equal(decodeJevResponse(response(event),event).answer.numeric_forecast,null);
  assert.throws(()=>buildJevRequest({...request,effort:"low"}),/only none/);
  assert.throws(()=>buildJevRequest({...request,tools:[{name:"search",description:"x",parameters:{}}]}),/only none/);
  assert.throws(()=>buildJevRequest({prompt:"unreviewed prompt"}),/reviewed/);
  const exceptional=prompt("Will guidance change?",null).replace("\n\nNumerical target:\nThis is an event-only question. Set numeric_forecast to null."," No numerical forecast is requested.");
  assert.equal(numericReference(exceptional),null);
});
test("event Brier uses direct Noul, not confidence, winning-bin probability, or numeric projection",()=>{
  const built=buildJevRequest(request), raw=response(built), out=decodeJevResponse(raw,built);
  assert.equal(out.answer.probability_yes,0.37);assert.equal(out.answer.numeric_forecast!.value,100.5);
  assert.match(out.answer.rationale,/not model reasoning/);
  parseForecastResponse(JSON.stringify(out.answer),"USD_billion");
  for(const modify of [(x:any)=>x.answers.event.noul=1.1,(x:any)=>delete x.answers.numeric.probabilities.b199,
    (x:any)=>x.answers.numeric.probabilities.b001=0.1,(x:any)=>x.model="jev-latest",(x:any)=>delete x.usage]) {
    const bad=structuredClone(raw);modify(bad);assert.throws(()=>decodeJevResponse(bad,built));
  }
});
test("reviewed Poly event-only prompts need no background and are sent verbatim",()=>{
  const poly=prompt("Will no one dissent the July Fed decision?",null)
    .replace("\n\nBackground known at the information as-of date:\nA permitted basic background.","");
  const messages=[{role:"system" as const,content:"Reviewed system"},{role:"user" as const,content:poly}];
  const prepared=buildJevRequest({prompt:poly,messages});
  assert.deepEqual(prepared.payload.state.reviewed_messages,messages);
  assert.deepEqual(Object.keys(prepared.payload.questions),["event"]);
  assert.equal(prepared.reference,null);
  assert.equal(decodeJevResponse(response(prepared),prepared).answer.probability_yes,.37);
  for(const section of ["\n\nInformation as-of date (UTC): ","\nPrediction cutoff (UTC): ","\n\nResolution criteria:\n"])
    assert.throws(()=>buildJevRequest({prompt:poly.replace(section,"removed")}),/reviewed/);
  assert.throws(()=>buildJevRequest({prompt:example.replace("\n\nBackground known at the information as-of date:\nA permitted basic background.","")}),/background/);
});
test("transport records exact request/response, usage and provenance without authentication values",async()=>{
  let called=false;const events:any[]=[];
  const client=new JevClient("test-secret",async(url,opts)=>{
    called=true;assert.equal(url,"https://api.typesafe.ai/v1/systemone");
    assert.equal((opts!.headers as any).Authorization,"Bearer test-secret");
    assert.deepEqual(JSON.parse(opts!.body as string),buildJevRequest(request).payload);
    return new Response(JSON.stringify(response()),{headers:{"x-request-id":"fixture"}});
  });
  const result=await client.complete({...request,onTrace:e=>events.push(e)});
  assert.ok(called);assert.equal(result.costUsd,0.000042);assert.equal(result.inputTokens,1000);
  assert.equal(events.filter(e=>e.type==="jev_request").length,1);assert.equal(events.filter(e=>e.type==="jev_response").length,1);
  assert.ok(!JSON.stringify(events).includes("test-secret"));
  assert.equal(result.reasoningCapture?.status,"not_returned");
  assert.match(client.reasoningConfiguration().api_parameters.typed_adapter!.toString(),/object/);
  const denied=new JevClient("test-secret",async()=>new Response('{"error":{"message":"test-secret"}}',{status:401}));
  await assert.rejects(()=>denied.complete(request),e=>!(e as Error).message.includes("test-secret") && (e as any).retryable===false);
});
test("Jev plugs into the standard none predictor and strict forecast contract",async()=>{
  const client=new JevClient("fixture-secret",async()=>new Response(JSON.stringify(response())));
  const predictor=new AgenticSearchPredictor(client,undefined,{maxToolCalls:0});
  const result=await predictor.predict({question_id:"fixture",question_text:"Will revenue exceed $100 billion?",resolution_criteria:"Over 100",resolution_date:"2026-09-01",as_of_date:"2026-07-01T00:00:00Z",prediction_cutoff_utc:"2026-09-01T00:00:00Z",response_format:"raven.forecast.v2.1",forecast_prompt:example,numeric_target_unit:"USD_billion",ground_truth:null,market_price_at_freeze:null,category:"finance",difficulty_level:"",source:"fixture",language:"en"},NullRetrievalEnv,"low");
  assert.equal(result.probabilities[0],0.37);assert.equal(result.numeric_forecast!.value,100.5);
  assert.deepEqual(result.format_repairs,[]);
});
test("formal admission permits only pinned Jev none without reasoning/evidence changes",()=>{
  const args=["--llm","jev:jev-1.13.0","--settings","none","--conc","4","--profile","custom","--questions-file","/tmp/questions.jsonl","--grading-file","/tmp/answers.jsonl"];
  assert.equal(formalArguments(args,PKG_ROOT).selected.llm,"jev:jev-1.13.0");
  for(const tail of [["--effort","low"],["--ledger","1"],["--evidence-file","extra.json"]])assert.throws(()=>formalArguments([...args,...tail],PKG_ROOT),/Jev requires/);
  assert.throws(()=>formalArguments(args.map(x=>x==="none"?"frozen":x),PKG_ROOT),/Jev requires/);
  assert.throws(()=>formalArguments(args.map(x=>x==="jev:jev-1.13.0"?"jev:jev-latest":x),PKG_ROOT),/Jev requires/);
});
test("offline 0.99-mass review is evidence-bound, leaves strict behavior unchanged and cannot alter predictions",()=>{
  const prepared=buildJevRequest(request),raw=response(prepared);
  raw.answers.numeric!.probabilities.b100=.99;
  assert.throws(()=>decodeJevResponse(raw,prepared),/probability mass/);
  const text=JSON.stringify(raw),decoded=decodeJevResponse(raw,prepared,JEV_REVIEW_POLICY);
  assert.equal(decoded.answer.probability_yes,.37);assert.equal(decoded.answer.numeric_forecast!.value,100.5);
  assert.equal(raw.answers.numeric!.probabilities.b100,.99,"raw weights must not be normalized in place");
  const review={question_id:"fixture",raw_sha256:sha256(text),reviewer:"fixture",reason:"native rounded mass",evidence_quotes:['"noul":0.37'],answer:decoded.answer};
  assert.deepEqual(reviewedJevForecast(text,example,"USD_billion",review),decoded.answer);
  assert.throws(()=>reviewedJevForecast(text,example,"USD_billion",{...review,answer:{...decoded.answer,probability_yes:.8}}),/cannot change/);
  raw.answers.numeric!.probabilities.b100=.98;
  assert.throws(()=>decodeJevResponse(raw,prepared,JEV_REVIEW_POLICY),/probability mass/);
  raw.answers.numeric!.probabilities.b100=.985;raw.answers.numeric!.probabilities.b101=.005;
  assert.throws(()=>decodeJevResponse(raw,prepared,JEV_REVIEW_POLICY),/probability mass/);
  const event=(body:string,status=200)=>({type:"llm_transport",data:{event:{type:"jev_response",data:{status,body}}}});
  const row={question_id:"fixture",status:"failed",condition:{model:"jev:jev-1.13.0",harness:"jev-none-200bins-v1"}};
  assert.equal(repairRawFinal([event("earlier"),event(text)],row),text);
  assert.throws(()=>repairRawFinal([event(text),event("error",500)],row),/Missing raw/);
  assert.throws(()=>repairRawFinal([event(text)],{...row,condition:{model:"other"}}),/Missing raw/);
});
