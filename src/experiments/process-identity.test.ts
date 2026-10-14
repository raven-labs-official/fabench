import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { readProcessIdentity, matchesRunningProcess } from "../process-identity.js";
import { ExperimentRegistry } from "./registry.js";
import { DashboardData } from "../dashboard/data.js";

test("process identity rejects missing PIDs, PID reuse, other hosts and prior boots", () => {
  const live = readProcessIdentity()!;
  const saved = { pid: live.pid, host: hostname(), startedTicks: live.startedTicks, bootId: live.bootId };
  assert.equal(matchesRunningProcess(saved), true);
  assert.equal(matchesRunningProcess({ ...saved, startedTicks: "old" }), false);
  assert.equal(matchesRunningProcess({ ...saved, bootId: "old" }), false);
  assert.equal(matchesRunningProcess({ ...saved, host: "other-host" }), false);
  assert.equal(readProcessIdentity(2147483647), null);
});

test("registry and dashboard mark an expired-heartbeat zombie as stale", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "fabench-zombie-status-"));
  const path = join(directory, "registry.sqlite"), registry = new ExperimentRegistry(path);
  const db = new DatabaseSync(path);
  const parent = spawn("python3", ["-u", "-c", `
import json, os, sys, time
from pathlib import Path
child = os.fork()
if child == 0:
    os._exit(0)
try:
    for _ in range(100):
        fields = Path(f'/proc/{child}/stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z':
            break
        time.sleep(0.01)
    print(json.dumps({'pid': child, 'state': fields[0]}), flush=True)
    sys.stdin.readline()
finally:
    os.waitpid(child, 0)
`], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: parent.stdout });
  const exited = new Promise<void>(resolve => parent.once("exit", () => resolve()));
  try {
    const line = await new Promise<string>((resolve, reject) => {
      lines.once("line", resolve);
      parent.once("error", reject);
      parent.once("exit", code => reject(new Error(`Process fixture exited early: ${code}`)));
    });
    const child = JSON.parse(line);
    assert.equal(child.state, "Z");
    const live = readProcessIdentity(child.pid)!;
    assert.equal(matchesRunningProcess({ ...live, host: hostname() }), false);
    registry.prepareRun({ runId: "run", experimentKey: "fixture", tag: "fixture", expectedCells: 0, config: {}, cells: [] });
    db.prepare("UPDATE runs SET pid=?,process_started_ticks=?,boot_id=?,last_heartbeat_utc=? WHERE run_id=?")
      .run(child.pid, live.startedTicks, live.bootId, new Date(Date.now() - 600_000).toISOString(), "run");
    assert.equal(registry.getRun("run")!.status, "stale");
    assert.equal(registry.listRuns({ active: true })[0]!.status, "stale");
    const dashboard = new DashboardData(path);
    try { assert.equal(dashboard.snapshot().runs[0].status, "stale"); }
    finally { dashboard.close(); }
  } finally {
    lines.close();
    parent.stdin.end("\n");
    await exited;
    db.close();
    registry.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
