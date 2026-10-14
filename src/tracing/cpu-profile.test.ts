import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startCpuProfiler } from "./cpu-profile.js";

function busy(ms: number) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 1);
  return x;
}

test("profiles are written in numbered segments and sampling stops cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cpu-profile-"));
  try {
    const profiler = startCpuProfiler(dir, { intervalMicros: 1000, segmentMs: 60_000 });
    busy(60);
    const first = await profiler.rotate();
    busy(60);
    const last = await profiler.stop();
    assert.equal(await profiler.stop(), undefined);
    assert.deepEqual(readdirSync(dir).sort(), [`cpu-${process.pid}-000.cpuprofile`, `cpu-${process.pid}-001.cpuprofile`]);
    for (const path of [first, last!]) {
      const profile = JSON.parse(readFileSync(path, "utf8"));
      assert.ok(profile.nodes.length > 0 && profile.samples.length > 10);
      assert.equal(profile.samples.length, profile.timeDeltas.length);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
