/**
 * Opt-in CPU sampling of this process's main thread, for finding where main-thread time goes
 * under real load. It uses an in-process inspector session, so no debugging port is opened
 * on the shared host. Profiles are written in segments so a killed run keeps all but the
 * last segment. It changes no experiment behaviour and is not part of any condition.
 */
import { Session } from "node:inspector";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CpuProfiler {
  /** Write the current segment and keep sampling. */
  rotate(): Promise<string>;
  /** Write the last segment and stop. */
  stop(): Promise<string | undefined>;
}

export function startCpuProfiler(
  directory: string,
  { intervalMicros = 5000, segmentMs = 600_000 }: { intervalMicros?: number; segmentMs?: number } = {},
): CpuProfiler {
  mkdirSync(directory, { recursive: true });
  const session = new Session();
  session.connect();
  const post = (method: string, params?: object) => new Promise<any>((resolve, reject) =>
    session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result))));
  let sequence = 0;
  let stopped = false;
  // Queue the start commands now, in order, so sampling covers the code that follows.
  let chain: Promise<unknown> = Promise.all([
    post("Profiler.enable"),
    post("Profiler.setSamplingInterval", { interval: intervalMicros }),
    post("Profiler.start"),
  ]);
  const write = async (restart: boolean): Promise<string> => {
    const { profile } = await post("Profiler.stop");
    const path = join(directory, `cpu-${process.pid}-${String(sequence++).padStart(3, "0")}.cpuprofile`);
    writeFileSync(path, JSON.stringify(profile));
    if (restart) await post("Profiler.start");
    return path;
  };
  const serial = <T>(step: () => Promise<T>): Promise<T> => {
    const next = chain.then(step);
    chain = next.catch(() => undefined);
    return next;
  };
  const timer = setInterval(() => {
    serial(() => write(true)).catch(error => console.error("[WARN] CPU profile segment failed:", error));
  }, segmentMs);
  timer.unref();
  return {
    rotate: () => serial(() => write(true)),
    stop: () => {
      if (stopped) return Promise.resolve(undefined);
      stopped = true;
      clearInterval(timer);
      return serial(async () => {
        try { return await write(false); } finally { session.disconnect(); }
      });
    },
  };
}
