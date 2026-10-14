import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isRetrievalInfrastructureError } from "./infrastructure-error.js";
import { PageDater } from "./page-dater.js";
import { projectEnv } from "../env-names.js";

function helper(source: string): { directory: string; script: string } {
  const directory = mkdtempSync(join(tmpdir(), "fabench-page-dater-test-"));
  const script = join(directory, "helper.mjs");
  writeFileSync(script, source);
  return { directory, script };
}

test('a real Python SIGABRT retains its native-fault traceback beyond the short status message', {
  // macOS opens a crash dialog even with core dumps disabled. Keep the real crash
  // in Linux CI; desktop developers can explicitly opt in when diagnosing it.
  skip: process.platform === 'darwin' && projectEnv("FABENCH_RUN_NATIVE_CRASH_TESTS") !== '1'
    ? 'intentional Python crash; set FABENCH_RUN_NATIVE_CRASH_TESTS=1 to opt in on macOS' : false,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fabench-native-fault-'));
  const script = join(directory, 'native-abort.py');
  writeFileSync(script, `import ctypes,faulthandler,json,os,resource,sys
resource.setrlimit(resource.RLIMIT_CORE,(0,0))
# Linux piped core handlers can ignore RLIMIT_CORE and delay the exit event.
# This fixture tests stderr/SIGABRT retention, so disable dumping in this child only.
if sys.platform == 'linux':
    prctl=ctypes.CDLL(None).prctl
    prctl.argtypes=[ctypes.c_int,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong]
    prctl.restype=ctypes.c_int
    assert prctl(4,0,0,0,0) == 0  # PR_SET_DUMPABLE
def native_abort_marker():
    sys.stderr.write('first-diagnostic-marker\\n' + 'x'*6000 + '\\n')
    sys.stderr.flush()
    os.abort()
assert faulthandler.is_enabled()
for line in sys.stdin:
    request=json.loads(line)
    if request.get('ping'):
        print(json.dumps({'id':request['id'],'ok':True,'reader':{'enabled':False,'ok':True},'results':[]}),flush=True)
    else:
        native_abort_marker()
`);
  const dater = new PageDater(false, process.env.HTMLDATE_PYTHON ?? 'python3', script, 5000,
    { policy: 'article-blocks-tables-v1', rawDirectory: directory });
  try {
    await dater.assertReady();
    await assert.rejects(dater.fetchMany(['https://capture.invalid/native-fault']), /signal=SIGABRT/);
    const stats = dater.snapshot();
    assert.equal(stats.helperHealthy, false);
    assert.equal(stats.helperFailureCode, 'helper_exit');
    const diagnostics = stats.helperDiagnostics!;
    assert(diagnostics.stderrPath);
    assert.equal(diagnostics.truncated, false);
    assert(diagnostics.retainedBytes > 6000);
    const bytes = readFileSync(diagnostics.stderrPath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), diagnostics.sha256);
    assert.match(bytes.toString(), /first-diagnostic-marker/);
    assert.match(bytes.toString(), /Fatal Python error: Aborted/);
    assert.match(bytes.toString(), /native_abort_marker/);
  } finally {
    dater.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('configured browser must provide a live startup proof before the page helper is ready', async()=>{
  const fixture=helper(`import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);process.stdout.write(JSON.stringify({id:req.id,ok:true,reader:{enabled:false,ok:true},browser:{enabled:true,ok:false,error:'missing browser executable'},results:[]})+'\\n');});`);
  const dater=new PageDater(false,process.execPath,fixture.script,1000,{policy:'article-blocks-tables-v1',rawDirectory:fixture.directory,browser:true});
  try{assert.equal(dater.configuration().preflight_timeout_ms,80000);await assert.rejects(dater.assertReady(),/Crawl4AI browser unavailable/);}
  finally{dater.close();rmSync(fixture.directory,{recursive:true,force:true});}
});

test("PageDater derives its outer preflight deadline from the reader timeout", () => {
  const previousReader = process.env.READER_TIMEOUT_S;
  const previousGrace = process.env.PAGE_DATER_PREFLIGHT_GRACE_MS;
  process.env.READER_TIMEOUT_S = "30";
  process.env.PAGE_DATER_PREFLIGHT_GRACE_MS = "5000";
  try {
    const config = new PageDater(true).configuration();
    assert.equal(config.reader_timeout_seconds, 30);
    assert.equal(config.preflight_grace_ms, 5_000);
    assert.equal(config.preflight_timeout_ms, 35_000);
    assert.equal(
      config.timeout_source,
      "READER_TIMEOUT_S + PAGE_DATER_PREFLIGHT_GRACE_MS",
    );
  } finally {
    if (previousReader === undefined) delete process.env.READER_TIMEOUT_S;
    else process.env.READER_TIMEOUT_S = previousReader;
    if (previousGrace === undefined)
      delete process.env.PAGE_DATER_PREFLIGHT_GRACE_MS;
    else process.env.PAGE_DATER_PREFLIGHT_GRACE_MS = previousGrace;
  }
});

test("PageDater health check rejects a missing helper instead of returning empty", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fabench-page-dater-missing-"));
  const dater = new PageDater(
    false,
    join(directory, "missing-python"),
    join(directory, "missing-script.py"),
    1_000,
  );
  try {
    await assert.rejects(dater.assertReady(), (error: unknown) => {
      assert.equal(isRetrievalInfrastructureError(error), true);
      if (isRetrievalInfrastructureError(error)) {
        assert.equal(error.component, "page-dater");
        assert.match(error.code, /spawn_error|stdin_error/);
      }
      return true;
    });
    assert.equal(dater.snapshot().helperHealthy, false);
  } finally {
    dater.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PageDater health check exercises the persistent helper protocol", async () => {
  const fixture = helper(`
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const req = JSON.parse(line);
      const results = (req.urls ?? []).map((url) => ({
        url, date: "2026-01-01", title: "fixture", text: "fixture", why: ""
      }));
      process.stdout.write(JSON.stringify({ id: req.id, ok: req.ping === true, results }) + "\\n");
    });
  `);
  const dater = new PageDater(false, process.execPath, fixture.script, 1_000);
  try {
    await dater.assertReady();
    const pages = await dater.fetchMany(["https://example.test/article"]);
    assert.equal(pages.length, 1);
    assert.equal(pages[0]?.date, "2026-01-01");
    assert.equal(dater.snapshot().helperHealthy, true);
  } finally {
    dater.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("PageDater treats an incomplete helper batch as infrastructure failure", async () => {
  const fixture = helper(`
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const req = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id: req.id, ok: req.ping === true, results: [] }) + "\\n");
    });
  `);
  const dater = new PageDater(false, process.execPath, fixture.script, 1_000);
  try {
    await dater.assertReady();
    await assert.rejects(
      dater.fetchMany(["https://example.test/article"]),
      (error: unknown) =>
        isRetrievalInfrastructureError(error) &&
        error.code === "incomplete_batch",
    );
  } finally {
    dater.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("PageDater rejects a failed live reader preflight", async () => {
  const fixture = helper(`
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const req = JSON.parse(line);
      process.stdout.write(JSON.stringify({
        id: req.id,
        ok: false,
        reader: { enabled: true, ok: false, http_status: 402, error: "InsufficientBalance" },
        results: []
      }) + "\\n");
    });
  `);
  const dater = new PageDater(true, process.execPath, fixture.script, 1_000);
  try {
    await assert.rejects(
      dater.assertReady(),
      (error: unknown) =>
        isRetrievalInfrastructureError(error) &&
        error.code === "reader_preflight_failed" &&
        /402/.test(error.message),
    );
    assert.equal(dater.snapshot().readerPreflightHttpStatus, 402);
  } finally {
    dater.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("shared quota heartbeats extend queue time without masking a stalled network request", async () => {
  const fixture = helper(`
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const req = JSON.parse(line);
      if (req.ping) { process.stdout.write(JSON.stringify({id:req.id,ok:true,results:[]})+"\\n"); return; }
      const heartbeat = setInterval(() => process.stdout.write(JSON.stringify({id:req.id,admission_wait:true})+"\\n"),50);
      setTimeout(() => {
        clearInterval(heartbeat);
        if (req.urls[0].includes('stalled')) return;
        process.stdout.write(JSON.stringify({id:req.id,results:req.urls.map(url=>({url,date:'2026-01-01',title:'fixture',text:'fixture',why:''}))})+"\\n");
      },600);
    });
  `);
  const dater = new PageDater(false, process.execPath, fixture.script, 250);
  try {
    await dater.assertReady();
    assert.equal((await dater.fetchMany(["https://example.test/queued"])).length,1);
    await assert.rejects(dater.fetchMany(["https://example.test/stalled"]),isRetrievalInfrastructureError);
  } finally { dater.close(); rmSync(fixture.directory,{recursive:true,force:true}); }
});
