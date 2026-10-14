import assert from "node:assert/strict";
import test from "node:test";
import { parseForecastResponse } from "./forecast-response.js";
import { AgenticSearchPredictor } from "./agentic-search.js";
import { NullRetrievalEnv,BudgetTier } from "./types.js";
import type { LlmClient,LlmRequest } from "../llm/client.js";
import type { SearchBackend } from "../retrieval/search-backend.js";
import type { Question } from "../types.js";

test("strict numeric contract preserves zero and rejects missing or malformed forecasts",()=>{
 const good={probability_yes:0,numeric_forecast:{value:0,unit:"percent"},rationale:"Zero is a valid forecast."};
 assert.equal(parseForecastResponse(JSON.stringify(good),"percent").numeric_forecast!.value,0);
 assert.equal(parseForecastResponse(JSON.stringify({...good,numeric_forecast:null}),null).numeric_forecast,null);
 for(const bad of [{...good,probability_yes:1.2},{...good,numeric_forecast:null},{...good,numeric_forecast:{value:2.3,unit:"proportion"}},{...good,numeric_forecast:{value:"2.3",unit:"percent"}},{...good,answer:"Yes"}])assert.throws(()=>parseForecastResponse(JSON.stringify(bad),"percent"));
 assert.throws(()=>parseForecastResponse("```json\n"+JSON.stringify(good)+"\n```","percent"));
 assert.throws(()=>parseForecastResponse(JSON.stringify(good),null));
});

test("structured prediction passes information as-of to search and fetch, never the future cutoff",async()=>{
 const asof="2026-03-01T00:00:00Z",cutoff="2026-07-25T23:59:59Z";
 const prompt=`Information as-of: ${asof}\nPrediction cutoff: ${cutoff}\nReturn one JSON object.`;
 const q:Question={question_id:"contract-tool-test",question_text:"Will the test metric exceed 1?",resolution_criteria:"Use the target value.",resolution_date:cutoff,as_of_date:asof,prediction_cutoff_utc:cutoff,response_format:"raven.forecast.v2.1",numeric_target_unit:"percent",forecast_prompt:prompt,ground_truth:1,market_price_at_freeze:null,category:"test",difficulty_level:"easy",source:"test",language:"en"};
 const seen:{kind:string,asof:string|undefined}[]=[];let calls=0;const requests:LlmRequest[]=[];
 const client:LlmClient={id:"fake:contract",async complete(req){requests.push(structuredClone({...req,onTrace:undefined}));calls++;return calls===1?{text:"Read the earlier report.",costUsd:0,inputTokens:0,outputTokens:0,toolCalls:[{id:"s",name:"web_search",args:{query:"historical metric"}},{id:"f",name:"web_fetch",args:{url:"https://example.test/historical"}}]}:{text:JSON.stringify({probability_yes:0.2,numeric_forecast:{value:0,unit:"percent"},rationale:"The permitted report supports a low estimate."}),costUsd:0,inputTokens:0,outputTokens:0};}};
 const backend:SearchBackend={name:"fake",async search(_q,_n,a){seen.push({kind:"search",asof:a});return[];},async fetch(_u,a){seen.push({kind:"fetch",asof:a});return{title:"Historical",url:"https://example.test/historical",body:"PRE-ASOF-REPORT",source:"frozen",crawlDate:"2026-02-28T00:00:00Z"};},stats(){return{};}};
 const p=await new AgenticSearchPredictor(client,backend,{maxToolCalls:2}).predict(q,NullRetrievalEnv,BudgetTier.Unlimited);
 assert.deepEqual(seen.sort((a,b)=>a.kind.localeCompare(b.kind)),[{kind:"fetch",asof},{kind:"search",asof}]);
 assert.equal(requests[0]!.messages[1]!.content,prompt);assert.ok(!JSON.stringify(requests[0]!.messages).includes("asterisks"));
 assert.deepEqual(p.numeric_forecast,{value:0,unit:"percent"});assert.equal(p.probabilities[0],0.2);
});

test("an answer with an extra field succeeds with its repair recorded; conflicting answers still fail",async()=>{
 const asof="2026-07-01T00:00:00Z",cutoff="2026-08-31T23:59:59Z";
 const q:Question={question_id:"repair-test",question_text:"Will the yield exceed 4.91%?",resolution_criteria:"Use the par yield.",resolution_date:cutoff,as_of_date:asof,prediction_cutoff_utc:cutoff,response_format:"raven.forecast.v2.1",numeric_target_unit:"percent",forecast_prompt:`Information as-of: ${asof}\nPrediction cutoff: ${cutoff}`,ground_truth:1,market_price_at_freeze:null,category:"test",difficulty_level:"easy",source:"test",language:"en"};
 const answer={probability_yes:0.45,numeric_forecast:{value:4.87,unit:"percent"},rationale:"Long yields drifted lower."};
 const run=async(text:string)=>{
  const events:{type:string;data?:any}[]=[];
  const client:LlmClient={id:"fake:repair",async complete(){return {text,costUsd:0,inputTokens:0,outputTokens:0};}};
  const p=await new AgenticSearchPredictor(client,undefined,{maxToolCalls:0,trace:{record:e=>events.push(e as any)}}).predict(q,NullRetrievalEnv,BudgetTier.Unlimited);
  return {p,events};
 };
 const {p,events}=await run(JSON.stringify({...answer,rationale_note:"Uses pre-cutoff data only."}));
 assert.equal(p.probabilities[0],0.45);assert.deepEqual(p.numeric_forecast,answer.numeric_forecast);
 assert.deepEqual(p.format_repairs,["extra_field:rationale_note"]);
 assert.deepEqual(events.find(e=>e.type==="forecast_format_repaired")?.data.repairs,["extra_field:rationale_note"]);
 assert.ok(p.rationale_md.includes("rationale_note"),"the raw reply is kept unchanged");
 const strict=await run(JSON.stringify(answer));
 assert.deepEqual(strict.p.format_repairs,[]);assert.ok(!strict.events.some(e=>e.type==="forecast_format_repaired"));
 await assert.rejects(run(JSON.stringify(answer)+JSON.stringify({...answer,probability_yes:0.6})),/conflicting/);
});
