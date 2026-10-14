import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadQuestionPool } from "./question-pool.js";

test("separate model/key contract preserves exact dates and changes identity with key", () => {
  const dir=mkdtempSync(join(tmpdir(),"fabench-contract-"));
  try {
    const model=join(dir,"model.jsonl"), key=join(dir,"key.jsonl");
    const r={id:"T1",question_en:"Will the metric exceed 1% in April 2026?",as_of_date:"2026-03-01T00:00:00Z",prediction_cutoff_utc:"2026-04-30T23:59:59Z",resolution_date:"2026-04-30T23:59:59Z",response_format:"raven.forecast.v2.1",numeric_target_unit:"percent",prompt:"Information: 2026-03-01T00:00:00Z. Target: 2026-04-30T23:59:59Z.",actual_value:"MUST_NOT_LEAK",market_value_at_anchor:0.99};
    const put=(rows:unknown[])=>writeFileSync(model,rows.map(x=>JSON.stringify(x)).join("\n"));
    put([r]);writeFileSync(key,JSON.stringify({id:"T1",answer:1}));
    const a=loadQuestionPool(model,key),q=a.questions[0]!;
    assert.equal(q.as_of_date,r.as_of_date);assert.equal(q.prediction_cutoff_utc,r.prediction_cutoff_utc);assert.equal(q.forecast_prompt,r.prompt);
    assert.equal(q.market_price_at_freeze,null);assert.ok(!JSON.stringify(q).includes("MUST_NOT_LEAK"));
    writeFileSync(key,JSON.stringify({id:"T1",answer:0}));const b=loadQuestionPool(model,key);
    assert.notEqual(a.identity.question_set_id,b.identity.question_set_id);assert.equal(a.identity.file_sha256,b.identity.file_sha256);assert.notEqual(a.identity.grading_file_sha256,b.identity.grading_file_sha256);
    put([r,r]);assert.throws(()=>loadQuestionPool(model,key),/Duplicate/);
    put([{...r,as_of_date:"2026-03-01"}]);assert.throws(()=>loadQuestionPool(model,key),/Invalid exact/);
    put([{...r,prediction_cutoff_utc:"2026-02-28T00:00:00Z"}]);assert.throws(()=>loadQuestionPool(model,key),/Invalid exact/);
    put([r]);writeFileSync(key,[{id:"T1",answer:1},{id:"extra",answer:0}].map(JSON.stringify).join("\n"));assert.throws(()=>loadQuestionPool(model,key),/exactly match/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("actual result dates stay in the grading key, including early events and later statistical releases", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabench-actual-dates-"));
  try {
    const model = join(dir, "model.jsonl"), key = join(dir, "key.jsonl");
    const common = {data_contract:"raven.question.v3",as_of_date:"2026-03-01T00:00:00Z",cut_off_time:"2026-03-01T00:00:00Z",response_format:"raven.forecast.v2.1"};
    const event = {...common,id:"EVENT",question_en:"Will an agreement be reached by July 30, 2026?",prediction_cutoff_utc:"2026-07-30T23:59:59Z",numeric_target_unit:null,prompt:"Information cutoff: 2026-03-01T00:00:00Z. Event deadline: 2026-07-30T23:59:59Z."};
    const numeric = {...common,id:"NUMERIC",question_en:"Will April inflation exceed 2%?",prediction_cutoff_utc:"2026-04-30T23:59:59Z",numeric_target_unit:"percent",prompt:"Information cutoff: 2026-03-01T00:00:00Z. Target period ends: 2026-04-30T23:59:59Z."};
    const eventGrade = {id:"EVENT",resolution_result:1,resolution_date:"2026-05-01",numeric_result:null};
    const numericGrade = {id:"NUMERIC",resolution_result:1,resolution_date:"2026-05-12T12:30:00Z",numeric_result:{value:2.3,unit:"percent"}};
    const put = (m:unknown[], g:unknown[]) => {writeFileSync(model,m.map(x=>JSON.stringify(x)).join("\n"));writeFileSync(key,g.map(x=>JSON.stringify(x)).join("\n"));};
    put([event,numeric],[eventGrade,numericGrade]);
    const loaded = loadQuestionPool(model,key);
    assert.equal(loaded.questions[0]!.resolution_date,"2026-05-01");
    assert.equal(loaded.questions[0]!.prediction_cutoff_utc,event.prediction_cutoff_utc);
    assert.equal(loaded.questions[1]!.resolution_date,"2026-05-12T12:30:00Z");
    assert.equal(loaded.questions[1]!.as_of_date,common.cut_off_time);
    assert.ok(!loaded.questions[0]!.forecast_prompt!.includes("2026-05-01"));
    assert.ok(!loaded.questions[1]!.forecast_prompt!.includes("2026-05-12"));
    assert.ok(!loaded.questions[1]!.forecast_prompt!.includes("2.3"));
    const identity = loaded.identity.question_set_id;
    put([event,numeric],[{...eventGrade,resolution_date:"2026-05-02"},numericGrade]);
    assert.notEqual(loadQuestionPool(model,key).identity.question_set_id,identity);
    for (const bad of [undefined,"2026-02-28","2026-03-01","2026-02-30","2026-04-31","2026-05-01T25:00:00Z"]) {
      put([event],[{...eventGrade,resolution_date:bad}]);
      assert.throws(()=>loadQuestionPool(model,key),/Actual resolution/);
    }
    put([{...event,resolution_date:"2026-05-01"}],[eventGrade]);
    assert.throws(()=>loadQuestionPool(model,key),/forbidden in model input/);
    put([{...event,cut_off_time:"2026-03-02T00:00:00Z"}],[eventGrade]);
    assert.throws(()=>loadQuestionPool(model,key),/Information cutoff/);
    const july = {...event,as_of_date:"2026-07-01T00:00:00Z",cut_off_time:"2026-07-01T00:00:00Z",
      prompt:"Information cutoff: 2026-07-01T00:00:00Z. Event deadline: 2026-07-30T23:59:59Z."};
    put([july],[{...eventGrade,resolution_date:"2026-07-20"}]);
    assert.equal(loadQuestionPool(model,key).questions[0]!.as_of_date,"2026-07-01T00:00:00Z");
    put([july],[eventGrade]);
    assert.throws(()=>loadQuestionPool(model,key),/Actual resolution/);
    for (const cutoff of ["2026-07-01","2026-07-01T00:00:00.000Z","2026-07-01T24:00:00Z"]) {
      put([{...july,as_of_date:cutoff,cut_off_time:cutoff}],[{...eventGrade,resolution_date:"2026-07-20"}]);
      assert.throws(()=>loadQuestionPool(model,key),/Information cutoff/);
    }
    put([numeric],[{...numericGrade,numeric_result:null}]);
    assert.throws(()=>loadQuestionPool(model,key),/Numeric result/);
    // A released key may withhold a licensed numeric value; the outcome still scores.
    put([numeric],[{...numericGrade,numeric_result:null,numeric_result_withheld:true}]);
    assert.equal(loadQuestionPool(model,key).questions[0]!.ground_truth,1);
    put([event],[{...eventGrade,numeric_result:{value:1,unit:"count"},numeric_result_withheld:true}]);
    assert.throws(()=>loadQuestionPool(model,key),/Numeric result/);
    put([numeric],[{...numericGrade,numeric_result:{value:2.3,unit:"USD"}}]);
    assert.throws(()=>loadQuestionPool(model,key),/Numeric result/);
    put([event],[{...eventGrade,numeric_result:{value:1,unit:"count"}}]);
    assert.throws(()=>loadQuestionPool(model,key),/Numeric result/);
    put([event],[{...eventGrade,resolution_result:0.5}]);
    assert.throws(()=>loadQuestionPool(model,key),/Invalid or duplicate/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
