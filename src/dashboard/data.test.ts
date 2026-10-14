import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,statSync,readFileSync} from "node:fs";
import {tmpdir,hostname} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {DashboardData,effectiveState,identityMatches,comparisonKey,metrics,safeText} from "./data.js";
import {ExperimentRegistry} from "../experiments/registry.js";
test("heartbeat and boot/PID identity distinguish stale and suspicious runs",()=>{
 const row={status:"running",last_heartbeat_utc:new Date(1000).toISOString()};
 assert.equal(effectiveState(row,false,200000).status,"stale");
 assert.equal(effectiveState(row,true,200000).status,"running");
 assert.equal(effectiveState(row,true,200000).livenessWarning,true);
 assert.equal(effectiveState(row,false,10000).status,"running");
 assert.equal(effectiveState({...row,status:"completed"},false,200000).status,"completed");
 const stat=readFileSync("/proc/self/stat","utf8"), ticks=stat.slice(stat.lastIndexOf(")")+2).split(" ")[19];
 assert.equal(identityMatches({pid:process.pid,host:hostname(),process_started_ticks:ticks}),true);
 assert.equal(identityMatches({pid:process.pid,host:hostname(),process_started_ticks:"bad"}),false);
 assert.equal(identityMatches({pid:process.pid,host:hostname(),boot_id:"old-boot"}),false);
});
test("comparison separates dataset, harness, budgets, interpretation and missing identity",()=>{
 const cfg={question_set_id:"Q",question_set:{file_sha256:"x",grading_file_sha256:"y"}};
 const c={condition_id:"a",model:"A",harness:"api",code_fingerprint_sha256:"code",max_tool_calls:20};
 const key=comparisonKey(cfg,c);
 assert.equal(key,comparisonKey(cfg,{...c,condition_id:"b",model:"B"}));
 for(const change of [{harness:"native"},{max_tool_calls:100},{code_fingerprint_sha256:"new"},{response_parse_policy:"other"}])assert.notEqual(key,comparisonKey(cfg,{...c,...change}));
 assert.notEqual(key,comparisonKey({...cfg,execution_mode:"postprocess"},c));
 assert.notEqual(key,comparisonKey({...cfg,question_set:{...cfg.question_set,grading_file_sha256:"z"}},c));
 assert.equal(comparisonKey({},c),null);
 assert.equal(comparisonKey({question_set_id:"A"},c),null);
 assert.equal(comparisonKey({question_set_id:"B"},c),null);
 assert.equal(comparisonKey({...cfg,question_set:{file_sha256:"x"}},c),null);
 assert.equal(comparisonKey({...cfg,question_set:{file_sha256:"x",grading_file_sha256:7}},c),null);
 assert.notEqual(key,comparisonKey({...cfg,question_set_id:"other"},c));
});

test("damaged run metadata is isolated and never represented as a strict comparable run", () => {
  const directory = mkdtempSync(join(tmpdir(), "fabench-dashboard-config-"));
  const path = join(directory, "registry.sqlite"), registry = new ExperimentRegistry(path);
  const db = new DatabaseSync(path);
  try {
    for (const id of ["valid", "damaged"])
      registry.prepareRun({ runId: id, experimentKey: id, tag: id, expectedCells: 0, config: {}, cells: [] });
    for (const raw of ["{", "null", "[]", "7", '{"conditions":{}}', '{"conditions":[null]}']) {
      db.prepare("UPDATE runs SET config_json=? WHERE run_id=?").run(raw, "damaged");
      const reader = new DashboardData(path);
      try {
        const snapshot = reader.snapshot();
        assert.equal(snapshot.runs.length, 2);
        assert.equal(snapshot.runs.find((row:any) => row.id === "valid").metadataError, null);
        const row = snapshot.runs.find((row:any) => row.id === "damaged");
        assert.equal(row.metadataError, "invalid_config");
        assert.equal(row.mode, null);
        assert.deepEqual(row.groups, []);
        const detail = reader.detail("damaged")!;
        assert.equal(detail.parameters, null);
        assert.equal(detail.costsStatus, "unavailable");
        assert.deepEqual(detail.metrics, []);
        assert.throws(() => reader.compare(["valid", "damaged"], "none"), /verified dataset/);
      } finally { reader.close(); }
    }
  } finally {
    db.close();
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("scoring excludes null, nonfinite, invalid probabilities and unsettled outcomes",()=>{
 const rows=[{probability:0,outcome:0},{probability:1,outcome:1},{probability:null,outcome:1},{probability:.8,outcome:null},{probability:2,outcome:1}];
 const m=metrics(rows);assert.equal(m.n,2);assert.equal(m.brier,0);assert.equal(m.brierIndex,100);assert.equal(m.accuracy,1);
 assert.equal(metrics([]).brier,null);assert.equal(metrics([{probability:.5,outcome:0}]).brierIndex,50);
 assert.deepEqual(metrics(rows),metrics(rows));
});
test("read-only adapter cannot create or write registry; sensitive config is projected away",()=>{
 const dir=mkdtempSync(join(tmpdir(),"fabench-dashboard-")),path=join(dir,"registry.sqlite");
 try{
 const db=new DatabaseSync(path);
 db.exec("CREATE TABLE runs(run_id TEXT, config_json TEXT, status TEXT, started_at_utc TEXT,last_heartbeat_utc TEXT,expected_cells INT,succeeded_cells INT,reused_cells INT,failed_cells INT,interrupted_cells INT,owner TEXT,tag TEXT); CREATE TABLE run_cells(run_id TEXT, question_id TEXT,condition_id TEXT,arm TEXT,status TEXT,probability REAL,source_run_id TEXT,updated_at_utc TEXT);");
 db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("id",JSON.stringify({llm:"A",token:"SECRET_CANARY",rationale:"PRIVATE_COT",environment_admission:{secret:"SECRET_CANARY"}}),"failed","2026-01-01","2026-01-01",4,1,1,2,0,"owner","tag");db.close();
 const before=statSync(path).mtimeMs,reader=new DashboardData(path);const s=JSON.stringify(reader.snapshot());assert.equal(s.includes("SECRET_CANARY"),false);assert.equal(s.includes("PRIVATE_COT"),false);
 assert.throws(()=>((reader as any).db as DatabaseSync).exec("DELETE FROM runs"),/readonly|read-only/i);
 assert.equal(reader.detail("missing"),null);assert.equal(reader.detail("id")!.done,4);reader.close();assert.equal(statSync(path).mtimeMs,before);
 assert.throws(()=>new DashboardData(join(dir,"missing.sqlite")));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("display strings redact common credentials and URLs",()=>{
 for(const s of ["Bearer secret","sk-test123","https://example.com/token","API_KEY=secret"])assert.equal(safeText(s),"[redacted]");
 assert.equal(safeText("codex:gpt-6-astra"),"codex:gpt-6-astra");
});

test("ranking uses only the common answered questions with identical labels",()=>{
 const base={model:"model",tag:"test",mode:"strict",groups:[{arm:"none",key:"same"}]};
 const a={...base,id:"a",cells:[{questionId:"Q1",arm:"none",probability:.2,outcome:0,status:"success"},
 {questionId:"Q2",arm:"none",probability:.8,outcome:1,status:"success"},{questionId:"Q3",arm:"none",probability:.8,outcome:1,status:"success"}]};
 const b={...base,id:"b",cells:[{questionId:"Q1",arm:"none",probability:.4,outcome:0,status:"success"},
 {questionId:"Q2",arm:"none",probability:null,outcome:1,status:"failed"},{questionId:"Q3",arm:"none",probability:.8,outcome:0,status:"success"}]};
 const fake={detail:(id:string)=>id==="a"?a:b};
 const comparison=DashboardData.prototype.compare.call(fake as any,["a","b"],"none");
 assert.deepEqual(comparison.questionIds,["Q1"]);assert.equal(comparison.rows[0]!.id,"a");
 assert.equal(comparison.rows[1]!.failed,1);assert.equal(comparison.rows[1]!.expected,3);
 b.groups=[{arm:"none",key:"different"}];
 assert.throws(()=>DashboardData.prototype.compare.call(fake as any,["a","b"],"none"),/conditions/);
});
