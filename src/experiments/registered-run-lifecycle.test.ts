import assert from "node:assert/strict";
import test from "node:test";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {ExperimentRegistry} from "./registry.js";
import {TraceArchive,sha256} from "../tracing/trace-archive.js";
import {notifyRegisteredStart,publishRegisteredRun,terminalFailureReasons} from "./registered-run-lifecycle.js";
import {reviewedForecast} from "./repair-forecast-run.js";
import { clearProjectEnv, projectEnv } from "../env-names.js";

test("an unrelated damaged run cannot block targeted start or terminal publication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fabench-lifecycle-isolation-"));
  const path = join(directory, "registry.sqlite"), registry = new ExperimentRegistry(path);
  const db = new DatabaseSync(path);
  let calls = 0;
  const send = async () => { calls++; return { code: 0 }; };
  try {
    registry.prepareRun({ runId: "old", tag: "old", experimentKey: "old", expectedCells: 0, config: {}, cells: [] });
    registry.finishRun("old", "completed");
    db.prepare("UPDATE runs SET config_json=? WHERE run_id=?").run("{", "old");
    const current = registry.prepareRun({ runId: "current", tag: "current", experimentKey: "current", expectedCells: 0, config: {}, cells: [] });
    const archive = new TraceArchive({ runId: current.runId, tag: "current", resultsDir: directory, expectedCells: 0, run: {} });
    registry.markRunning(current.runId, archive.directory);
    assert.deepEqual(registry.listRuns({ active: true }).map(run => run.runId), ["current"]);
    db.prepare("UPDATE runs SET config_json=? WHERE run_id=?").run("null", current.runId);
    await assert.rejects(() => notifyRegisteredStart(registry, current.runId, send), /current config_json/);
    assert.equal(calls, 0);
    db.prepare("UPDATE runs SET config_json=? WHERE run_id=?").run("{}", current.runId);
    await notifyRegisteredStart(registry, current.runId, send);
    await notifyRegisteredStart(registry, current.runId, send);
    assert.equal(calls, 1);
    archive.finish("completed");
    registry.finishRun(current.runId, "completed");
    const publication = await publishRegisteredRun(registry, current.runId, send);
    assert.equal(JSON.parse(readFileSync(publication, "utf8")).run_id, current.runId);
    await publishRegisteredRun(registry, current.runId, send);
    assert.equal(calls, 2);
    db.prepare("UPDATE runs SET config_json=? WHERE run_id=?").run("null", "current");
    await assert.rejects(() => publishRegisteredRun(registry, current.runId, send), /current config_json/);
    assert.equal(calls, 2);
  } finally {
    db.close();
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("notices follow registration; terminal publication preserves artifacts and does not send twice",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"fabench-lifecycle-"));const registry=new ExperimentRegistry(join(dir,"r.sqlite"));
 const sent:string[]=[];const send=async(s:string)=>{sent.push(s);return {code:0};};
 try {
  await assert.rejects(()=>notifyRegisteredStart(registry,"missing",send));
  const p=registry.prepareRun({tag:"test",experimentKey:"k",expectedCells:1,config:{conditions:[{model:"test",arm:"none"}]},cells:[{conditionId:"c",questionId:"Q",arm:"none"}]});
  const a=new TraceArchive({runId:p.runId,resultsDir:dir,tag:"test",expectedCells:1,run:{}});
  registry.markRunning(p.runId,a.directory);
  await notifyRegisteredStart(registry,p.runId,send);await notifyRegisteredStart(registry,p.runId,send);
  assert.equal(sent.length,1);assert.ok(sent[0].includes(p.runId));
  await assert.rejects(()=>publishRegisteredRun(registry,p.runId,send));
  const cell=a.beginCell({question_id:"Q",arm:"none",question:"?",as_of:"2026-03-01"});
  cell.finish("success",{probability:0,numeric_forecast:{value:0,unit:"USD"}});
  registry.recordCell(p.runId,{conditionId:"c",questionId:"Q",arm:"none",status:"success",probability:0,tracePath:cell.path});
  a.finish("completed");registry.finishRun(p.runId,"completed");
  const path=await publishRegisteredRun(registry,p.runId,send);const pub=JSON.parse(readFileSync(path,"utf8"));
  assert.equal(pub.counts.success,1);assert.equal(pub.files[0].sha256,sha256(readFileSync(pub.files[0].path)));
  await publishRegisteredRun(registry,p.runId,send);assert.equal(sent.length,2);
 } finally {registry.close();rmSync(dir,{recursive:true,force:true});}
});

test("an uncertain Feishu POST is recorded and never blindly resent",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"fabench-notify-"));const registry=new ExperimentRegistry(join(dir,"r.sqlite"));let calls=0;
 try {
  const p=registry.prepareRun({tag:"test",experimentKey:"k",expectedCells:0,config:{},cells:[]});
  const a=new TraceArchive({runId:p.runId,resultsDir:dir,tag:"test",expectedCells:0,run:{}});registry.markRunning(p.runId,a.directory);
  const send=async()=>{calls++;throw new Error("connection lost");};
  await assert.rejects(()=>notifyRegisteredStart(registry,p.runId,send));
  await assert.rejects(()=>notifyRegisteredStart(registry,p.runId,send));assert.equal(calls,1);
  a.finish("failed");registry.finishRun(p.runId,"failed");
 } finally {registry.close();rmSync(dir,{recursive:true,force:true});}
});

test("batch children suppress routine notices while failure reasons remain operator-facing",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"fabench-batch-notify-"));const registry=new ExperimentRegistry(join(dir,"r.sqlite"));
 const sent:string[]=[];const send=async(s:string)=>{sent.push(s);return {code:0};};
 const previous=projectEnv("FABENCH_REGISTERED_NOTICE_POLICY");
 try {
  process.env.FABENCH_REGISTERED_NOTICE_POLICY="batch-child";
  const p=registry.prepareRun({tag:"child",experimentKey:"k",expectedCells:0,config:{conditions:[{model:"kimi:k3",arm:"frozen"}]},cells:[]});
  const a=new TraceArchive({runId:p.runId,resultsDir:dir,tag:"child",expectedCells:0,run:{}});registry.markRunning(p.runId,a.directory);
  await notifyRegisteredStart(registry,p.runId,send);
  assert.equal(sent.length,0);assert.equal(JSON.parse(readFileSync(join(a.directory,"notifications/start.json"),"utf8")).status,"batched");
  a.finish("completed");registry.finishRun(p.runId,"completed");
  await publishRegisteredRun(registry,p.runId,send);assert.equal(sent.length,0);
  assert.equal(JSON.parse(readFileSync(join(a.directory,"notifications/terminal.json"),"utf8")).status,"batched");
  const failed=registry.prepareRun({tag:"failed-child",experimentKey:"f",expectedCells:0,config:{},cells:[]});
  const fa=new TraceArchive({runId:failed.runId,resultsDir:dir,tag:"failed-child",expectedCells:0,run:{}});
  registry.markRunning(failed.runId,fa.directory);await notifyRegisteredStart(registry,failed.runId,send);
  fa.finish("failed");registry.finishRun(failed.runId,"failed");
  const failedPub=await publishRegisteredRun(registry,failed.runId,send);
  assert.equal(JSON.parse(readFileSync(failedPub,"utf8")).status,"failed");
  assert.equal(JSON.parse(readFileSync(join(fa.directory,"notifications/terminal.json"),"utf8")).status,"batched");
  assert.equal(sent.length,0);
  const cells=join(a.directory,"cells");mkdirSync(cells,{recursive:true});
  writeFileSync(join(cells,"failed.jsonl"),JSON.stringify({type:"cell_finished",data:{error:{message:"kimi API 403: 5-hour usage limit reached"}}})+"\n");
  assert.deepEqual(terminalFailureReasons({...registry.listRuns()[0]!,traceDirectory:a.directory} as any),["kimi API 403: 5-hour usage limit reached"]);
 } finally {
  if(previous===undefined) clearProjectEnv("FABENCH_REGISTERED_NOTICE_POLICY"); else process.env.FABENCH_REGISTERED_NOTICE_POLICY=previous;
  registry.close();rmSync(dir,{recursive:true,force:true});
 }
});

test("manual interpretation requires matching raw hash and literal source evidence",()=>{
 const raw="Probability Yes: 35%; point forecast: 4%";
 const review={question_id:"Q",raw_sha256:sha256(raw),reviewer:"reviewer",reason:"Extract explicit final forecast",evidence_quotes:[raw],answer:{probability_yes:.35,numeric_forecast:{value:4,unit:"percent"},rationale:raw}};
 assert.equal(reviewedForecast(raw,"percent",review).numeric_forecast!.value,4);
 assert.throws(()=>reviewedForecast(raw+"changed","percent",review));
 assert.throws(()=>reviewedForecast(raw,"percent",{...review,evidence_quotes:["absent"]}));
 assert.throws(()=>reviewedForecast(raw,"USD",review));
});

test("document cleaning diagnostics publish sample counts without creating forecast success cells",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"fabench-cleaning-notice-"));const registry=new ExperimentRegistry(join(dir,"r.sqlite"));
 const sent:string[]=[];const send=async(s:string)=>{sent.push(s);return {code:0};};
 try {
  const run=registry.prepareRun({tag:"diagnostic",experimentKey:"cleaning",expectedCells:0,cells:[],config:{execution_mode:"reader-cleaning",model:"synthetic",sample_count:2,conc:2}});
  registry.markRunning(run.runId,dir);
  writeFileSync(join(dir,"manifest.json"),JSON.stringify({run_id:run.runId,status:"running",summary:{completed:0}}));
  await notifyRegisteredStart(registry,run.runId,send);
  writeFileSync(join(dir,"manifest.json"),JSON.stringify({run_id:run.runId,status:"completed",summary:{completed:2}}));
  writeFileSync(join(dir,"sample-results.json"),'[]');registry.finishRun(run.runId,"completed");
  const pub=JSON.parse(readFileSync(await publishRegisteredRun(registry,run.runId,send),"utf8"));
  assert.equal(pub.counts.success,0);assert.ok(pub.files.some((f:any)=>f.path.endsWith('sample-results.json')));
  assert.ok(sent[0]!.includes('page samples: 2'));assert.ok(sent[1]!.includes('no forecast probability produced'));
 } finally {registry.close();rmSync(dir,{recursive:true,force:true});}
});
