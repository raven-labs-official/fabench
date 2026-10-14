import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {ExperimentRegistry, type ReusedRegistryCell} from "./registry.js";
import {resolveRepairSources,repairRawFinal,interpretRetryForecast,validateRetainedMissing} from "./repair-forecast-run.js";
import {sha256} from "../tracing/trace-archive.js";

test("retry interpretation preserves explicit answers and binds reviews to the retry raw hash",()=>{
  const answer={probability_yes:0.4,numeric_forecast:null,rationale:"original reason"};
  assert.equal(interpretRetryForecast(JSON.stringify(answer),null).answer.probability_yes,0.4);
  const raw=JSON.stringify({...answer,note:null});
  const review={question_id:"Q001",answer,raw_sha256:sha256(raw),reviewer:"test",reason:"drop note",evidence_quotes:["original reason"]};
  assert.deepEqual(interpretRetryForecast(raw,null,review).answer,answer);
  assert.throws(()=>interpretRetryForecast(raw,null),/keys/);
  assert.throws(()=>interpretRetryForecast("",null,review),/mismatch/);
  assert.throws(()=>interpretRetryForecast(JSON.stringify(answer),null,review),/strict success/);
});

test("only an explicitly replaced failed cell may have an empty original answer",()=>{
  const events=[{type:"agent_failed",data:{partial_final_answer:""}}];
  const row={question_id:"empty",status:"failed"};
  assert.throws(()=>repairRawFinal(events,row),/Missing raw final/);
  assert.equal(repairRawFinal(events,row,true),"");
  assert.throws(()=>repairRawFinal(events,{...row,status:"success"},true),/Missing raw final/);
  assert.equal(repairRawFinal([{type:"agent_finished",data:{final_answer:"original"}}],row,true),"original");
});

test("partial interpretation retains empty failures and cannot discard any existing forecast",()=>{
  const row={question_id:"Q003",status:"failed"};
  const item={question_id:"Q003",reason:"Source exceeded model context capacity before producing a final answer"};
  assert.doesNotThrow(()=>validateRetainedMissing("",row,item));
  for(const raw of ['{"probability_yes":0.9}', 'malformed but nonempty final answer'])
    assert.throws(()=>validateRetainedMissing(raw,row,item),/empty failed/);
  assert.throws(()=>validateRetainedMissing("",{...row,status:"success"},item),/empty failed/);
  assert.throws(()=>validateRetainedMissing("",row,{...item,question_id:"other"}),/empty failed/);
  assert.throws(()=>validateRetainedMissing("",row,{...item,reason:" "}),/empty failed/);
});

function fixture() {
  const root=mkdtempSync(join(tmpdir(),"repair-reuse-"));
  const registry=new ExperimentRegistry(":memory:");
  const condition={condition_id:"condition:frozen",arm:"frozen"};
  const spec=(id:string)=>({conditionId:condition.condition_id,questionId:id,arm:condition.arm});
  const row=(id:string,status:string,probability:number|null)=>({question_id:id,arm:"frozen",condition,
    status,probability,trace_file:`${id}.jsonl`});
  function run(id:string, selected:string[], rows:ReturnType<typeof row>[], replicate=false) {
    const directory=join(root,id);mkdirSync(directory);
    registry.prepareRun({runId:id,experimentKey:"experiment",tag:id,expectedCells:selected.length,
      config:{conditions:[condition],selected_question_ids:selected},cells:selected.map(spec),
      replicate,replicateReason:replicate?"test changed canonical source":undefined});
    registry.markRunning(id,directory);
    writeFileSync(join(directory,"cells.jsonl"),rows.map(r=>JSON.stringify(r)).join("\n")+"\n");
    for(const r of rows) registry.recordCell(id,{...spec(r.question_id),status:r.status as "success"|"failed",
      probability:r.probability,tracePath:join(directory,r.trace_file)});
    registry.finishRun(id,rows.some(r=>r.status==="failed")?"failed":"completed");
  }
  run("probe",["Q001"],[row("Q001","success",0.3)]);
  run("batch",["Q001","Q002"],[row("Q002","failed",null)]);
  return {root,registry,row,run,cleanup:()=>{registry.close();rmSync(root,{recursive:true,force:true});}};
}

test("repair follows the source run's reuse receipt when later replicas exist",()=>{
  const f=fixture();
  try {
    f.run("replica",["Q001"],[f.row("Q001","success",0.9)],true);
    assert.equal(f.registry.listRuns().find(r=>r.runId==="replica")!.succeededCells,1);
    const runs=f.registry.listRuns();const source=f.registry.getRun("batch")!;
    const reused=f.registry.getRunReusedCells("batch");
    assert.equal(reused.length,1);assert.equal(reused[0]!.sourceRunId,"probe");
    const verified:string[]=[];
    const rows=resolveRepairSources(source,runs,reused,dir=>{verified.push(dir);});
    assert.equal(rows.size,2);
    assert.equal(rows.get("Q001")!.runId,"probe");
    assert.equal(rows.get("Q001")!.row.probability,0.3);
    assert.equal(rows.get("Q001")!.reused,true);
    assert.equal(rows.get("Q002")!.runId,"batch");
    assert.deepEqual(verified,[join(f.root,"batch"),join(f.root,"probe")]);
  } finally {f.cleanup();}
});

test("repair rejects missing, mismatched or ambiguous reused sources",()=>{
  const f=fixture();
  try {
    const runs=f.registry.listRuns(),source=f.registry.getRun("batch")!;
    const reused=f.registry.getRunReusedCells("batch");
    assert.throws(()=>resolveRepairSources(source,runs,[],()=>{}),/Missing source trace/);
    for(const patch of [
      {sourceRunId:"missing"},{probability:0.8},{probability:NaN},{tracePath:null},
      {tracePath:"/unrelated/Q001.jsonl"},{conditionId:"other"},{arm:"none"},
      {questionId:"unknown"},
    ] as Partial<ReusedRegistryCell>[]) {
      assert.throws(()=>resolveRepairSources(source,runs,[{...reused[0]!,...patch}],()=>{}));
    }
    assert.throws(()=>resolveRepairSources(source,runs,[...reused,...reused],()=>{}),/duplicate/);
    assert.throws(()=>resolveRepairSources(source,runs,reused,()=>{throw new Error("Hash mismatch");}),/Hash mismatch/);
    const probe=join(f.root,"probe","cells.jsonl");
    for(const rows of [
      [f.row("Q001","failed",0.3)],
      [f.row("Q001","success",0.3),f.row("Q001","success",0.3)],
      [{...f.row("Q001","success",0.3),condition:{condition_id:"other",arm:"frozen"}}],
    ]) {
      writeFileSync(probe,rows.map(r=>JSON.stringify(r)).join("\n")+"\n");
      assert.throws(()=>resolveRepairSources(source,runs,reused,()=>{}),/historical receipt/);
    }
  } finally {f.cleanup();}
});

test("explicit repair selection isolates one arm and preserves historical reuse",()=>{
  const f=fixture();
  try {
    const runs=f.registry.listRuns();const original=f.registry.getRun("batch")!;
    const source={...original,config:{...original.config,conditions:[...(original.config.conditions as any[]),
      {condition_id:"condition:none",arm:"none"}]}};
    const extra={...f.row("Q002","success",0.8),arm:"none",condition:{condition_id:"condition:none",arm:"none"}};
    writeFileSync(join(source.traceDirectory!,"cells.jsonl"),[f.row("Q002","failed",null),extra].map(JSON.stringify).join("\n")+"\n");
    const reused=f.registry.getRunReusedCells("batch");
    assert.throws(()=>resolveRepairSources(source,runs,reused,()=>{}),/Invalid repair selection/);
    const chosen=resolveRepairSources(source,runs,reused,()=>{},{arm:"frozen",question_ids:["Q001"]});
    assert.equal(chosen.size,1);assert.equal(chosen.get("Q001")!.runId,"probe");
    assert.equal(chosen.get("Q001")!.row.probability,0.3);
    for(const selection of [{arm:"missing",question_ids:["Q001"]},{arm:"frozen",question_ids:[]},
      {arm:"frozen",question_ids:["unknown"]},{arm:"frozen",question_ids:["Q001","Q001"]}])
      assert.throws(()=>resolveRepairSources(source,runs,reused,()=>{},selection),/Invalid repair selection/);
    assert.throws(()=>resolveRepairSources(source,runs,[],()=>{},{arm:"frozen",question_ids:["Q001"]}),/Missing source trace/);
    assert.throws(()=>resolveRepairSources(source,runs,reused,()=>{throw new Error("hash mismatch");},
      {arm:"frozen",question_ids:["Q001"]}),/hash mismatch/);
  } finally {f.cleanup();}
});
