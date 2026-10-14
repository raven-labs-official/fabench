import assert from "node:assert/strict";
import test from "node:test";
import {normalizeForecastResponse} from "./normalize-forecast.js";
const answer={probability_yes:0.6,numeric_forecast:{value:56.5,unit:"billion USD"},rationale:"Revenue forecast."};
test("normalization converts units and preserves probability, zero and explanation",()=>{
 const n=normalizeForecastResponse(JSON.stringify(answer),"USD");
 assert.equal(n.answer.numeric_forecast!.value,56500000000);assert.equal(n.answer.probability_yes,0.6);
 assert.equal(n.answer.rationale,answer.rationale);assert.equal(n.strict,false);
 const zero={...answer,probability_yes:0,numeric_forecast:{value:0,unit:"USD"}};
 assert.deepEqual(normalizeForecastResponse(JSON.stringify(zero),"USD"),{answer:zero,strict:true,corrections:[]});
});
test("a single fenced forecast and audited key typo can be recovered without guessing",()=>{
 const raw='Forecast follows.\n```json\n'+JSON.stringify({probability_yes:0.12,numeric_forest:null,rationate:"Event forecast."})+'\n```';
 const n=normalizeForecastResponse(raw,null);assert.equal(n.answer.probability_yes,0.12);assert.equal(n.answer.rationale,"Event forecast.");assert.equal(n.corrections.length,3);
});
test("ambiguous, missing and semantically different units remain failures",()=>{
 for(const raw of [JSON.stringify({...answer,probability_yes:2}),JSON.stringify({...answer,numeric_forecast:null}),JSON.stringify({...answer,numeric_forecast:{value:12,unit:"percent"}}),JSON.stringify({...answer,rationate:"different"}),"Probably about half."])
  assert.throws(()=>normalizeForecastResponse(raw,"percentage_points"));
 assert.throws(()=>normalizeForecastResponse('```json\n'+JSON.stringify(answer)+'\n```\n'+JSON.stringify(answer),"USD"));
 assert.throws(()=>normalizeForecastResponse(JSON.stringify({...answer,numeric_forecast:{value:"56.5",unit:"billion USD"}}),"USD"));
});
