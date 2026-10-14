import {setTimeout as abortablePause} from 'node:timers/promises';
/** Cross-process, cross-user API admission. No prompts, credentials or answers enter this DB. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { SHARED_ROOT } from "../site-config.js";
import { projectEnv } from "../env-names.js";

export const RATE_POLICY = Object.freeze({
  version: "raven.shared-api-admission.v1", baseline_cap: 64, min_cap: 1,
  first_cooldown_ms: 30_000, max_cooldown_ms: 300_000,
  first_gap_ms: 1_000, max_gap_ms: 30_000,
  recovery_ms: 60_000, recovery_successes: 10, lease_ms: 120_000,
});
/** Wake-up scheduling only; all admission decisions still use one SQLite transaction. */
export const RATE_WAIT_POLICY = Object.freeze({ version: 'fifo-start-deadline-v1',
  occupied_poll_ms: 100, max_poll_ms: 1000 });
export const SHARED_RATE_DB = `${SHARED_ROOT}/runs/raven-bench/api-admission.sqlite`;
// Wikimedia's 2026 identified-anonymous limit is shared across projects.
// Serialize Action API reads and stay below 200/minute; shared 429 cooldown
// remains authoritative. The resource identifies the shared egress, not a key.
export const WIKIMEDIA_API_LIMIT = Object.freeze({ resource: 'api:wikimedia:anonymous-ip', concurrency: 1, min_gap_ms: 350 });
export type RateTrace = (event: { type: string; data: Record<string, unknown> }) => void;
export interface RateState {
  resource: string; cap: number; gap_ms: number; cooldown_until: number;
  next_start: number; last_limit: number; last_recovery: number; successes: number;
  penalties: number;
}
export interface Permit { signal?: AbortSignal; limited(retryAfter?: string | null): void; release(success?: boolean): void; }
/** Operator-selected operating limits. These are not inferred provider quotas. */
export interface ResourceLimits {
  resource: string; concurrency: number; min_gap_ms: number; basis: string;
}

/** Same endpoint credential shares a quota across models, predictor/reviewer, users and runs. */
export function apiResource(provider: string, endpoint: string, credential: string): string {
  const origin = new URL(endpoint).origin;
  const digest = createHash("sha256").update(origin + "\0" + credential).digest("hex").slice(0, 24);
  return `api:${new URL(origin).host}:${digest}`;
}
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

export class SharedRateLimiter {
  private readonly db: DatabaseSync;
  constructor(readonly path: string, private readonly now = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o2770 });
    this.db = new DatabaseSync(path);
    // WAL with synchronous=NORMAL keeps the database consistent without forcing every commit
    // to disk. Each API call commits several times on the experiment's main thread, and the
    // per-commit disk flush was its largest wait. A host power loss can drop only the newest
    // commits; leases are short-lived and every process dies with the host anyway.
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_policy (id INTEGER PRIMARY KEY CHECK(id=1), version TEXT NOT NULL);
      INSERT OR IGNORE INTO api_policy VALUES(1, '${RATE_POLICY.version}');
      CREATE TABLE IF NOT EXISTS api_resources (
        resource TEXT PRIMARY KEY, cap INTEGER NOT NULL, gap_ms INTEGER NOT NULL,
        cooldown_until INTEGER NOT NULL, next_start INTEGER NOT NULL, last_limit INTEGER NOT NULL,
        last_recovery INTEGER NOT NULL, successes INTEGER NOT NULL, penalties INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_requests (
        ticket INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, resource TEXT NOT NULL,
        owner TEXT NOT NULL, run_id TEXT NOT NULL, pid INTEGER NOT NULL,
        state TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS api_requests_resource ON api_requests(resource,state,ticket);
      CREATE TABLE IF NOT EXISTS api_resource_limits (
        resource TEXT PRIMARY KEY, concurrency INTEGER NOT NULL, min_gap_ms INTEGER NOT NULL,
        basis TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, owner TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_events (
        id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, resource TEXT NOT NULL,
        owner TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, details_json TEXT NOT NULL
      );
    `);
    const policy = this.sql("SELECT version FROM api_policy WHERE id=1").get() as { version: string };
    if (policy.version !== RATE_POLICY.version) throw new Error("Shared API admission policy mismatch; run the environment checker");
    if (path !== ":memory:") for (const f of [path, path + "-wal", path + "-shm"]) {
      if (existsSync(f)) try { chmodSync(f, 0o660); } catch { /* existing team-owned file */ }
    }
  }
  close() { this.statements.clear(); this.db.close(); }
  /** Compile each statement once; node:sqlite resets a statement after every call. */
  private readonly statements = new Map<string, StatementSync>();
  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) { statement = this.db.prepare(text); this.statements.set(text, statement); }
    return statement;
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private state(resource: string): RateState {
    this.sql("INSERT OR IGNORE INTO api_resources VALUES(?,?,?,?,?,?,?,?,?)")
      .run(resource, this.operatingLimits(resource).concurrency, 0, 0, 0, 0, 0, 0, 0);
    return this.sql("SELECT * FROM api_resources WHERE resource=?").get(resource) as unknown as RateState;
  }
  private operatingLimits(resource: string): { concurrency: number; min_gap_ms: number } {
    const selected = this.sql('SELECT concurrency,min_gap_ms FROM api_resource_limits WHERE resource=?').get(resource) as
      {concurrency:number;min_gap_ms:number} | undefined;
    const configured = selected ?? {concurrency:RATE_POLICY.baseline_cap,min_gap_ms:0};
    return resource === WIKIMEDIA_API_LIMIT.resource
      ? {concurrency:Math.min(configured.concurrency,WIKIMEDIA_API_LIMIT.concurrency),min_gap_ms:Math.max(configured.min_gap_ms,WIKIMEDIA_API_LIMIT.min_gap_ms)}
      : configured;
  }
  /** Call only while experiments are quiescent under the platform policy lock.
   * The transaction also rejects live leases, including unregistered API users.
   * A previously reduced congestion cap is preserved when its ceiling is raised.
   */
  configureResources(limits: readonly ResourceLimits[], reason: string, owner = userInfo().username) {
    if (!limits.length || !reason.trim() || !owner.trim()) throw new Error('Resource limits require entries, owner and reason');
    const seen = new Set<string>();
    for (const limit of limits) {
      if (!/^[a-z0-9][a-z0-9:._/-]{0,199}$/.test(limit.resource) || seen.has(limit.resource)
        || !Number.isSafeInteger(limit.concurrency) || limit.concurrency < 1
        || !Number.isSafeInteger(limit.min_gap_ms) || limit.min_gap_ms < 0
        || !Number.isSafeInteger(this.now()+limit.min_gap_ms) || !limit.basis?.trim()) throw new Error('Invalid or duplicate resource limit');
      if (limit.resource === WIKIMEDIA_API_LIMIT.resource
        && (limit.concurrency > WIKIMEDIA_API_LIMIT.concurrency || limit.min_gap_ms < WIKIMEDIA_API_LIMIT.min_gap_ms))
        throw new Error('Configured limits cannot relax the Wikimedia source limit');
      seen.add(limit.resource);
    }
    this.transaction(() => {
      const now = this.now();
      const live = this.sql('SELECT count(*) AS n FROM api_requests WHERE expires>=?').get(now) as {n:number};
      if (live.n) throw new Error('Cannot configure API limits while requests are active or waiting');
      for (const limit of limits) {
        const prior = this.operatingLimits(limit.resource), state = this.state(limit.resource);
        this.sql(`INSERT INTO api_resource_limits VALUES(?,?,?,?,?,?) ON CONFLICT(resource) DO UPDATE SET
          concurrency=excluded.concurrency,min_gap_ms=excluded.min_gap_ms,basis=excluded.basis,
          updated_at_ms=excluded.updated_at_ms,owner=excluded.owner`).run(limit.resource,limit.concurrency,limit.min_gap_ms,limit.basis,now,owner);
        const cap = state.cap === prior.concurrency && state.penalties === 0
          ? limit.concurrency : Math.min(state.cap,limit.concurrency);
        this.sql('UPDATE api_resources SET cap=? WHERE resource=?').run(cap,limit.resource);
        this.event({resource:limit.resource,owner,run_id:'resource-configuration'},'limits_configured',
          {prior,configured:limit,effective_cap:cap,reason});
      }
    });
    return this.snapshot();
  }
  enqueue(resource: string, owner: string, runId: string, pid = process.pid): string {
    const token = randomUUID();
    this.transaction(() => {
      this.state(resource);
      this.sql("INSERT INTO api_requests(token,resource,owner,run_id,pid,state,expires) VALUES(?,?,?,?,?,'waiting',?)")
        .run(token, resource, owner, runId, pid, this.now() + RATE_POLICY.lease_ms);
    });
    return token;
  }
  renew(token: string) {
    const result = this.sql("UPDATE api_requests SET expires=? WHERE token=?").run(this.now() + RATE_POLICY.lease_ms, token);
    if (Number(result.changes) !== 1) throw new Error("Shared API admission lease is missing");
  }
  tryAdmit(token: string): { admitted: boolean; admitted_at_ms?: number; wait_ms: number; state: RateState } {
    return this.transaction(() => {
      const now = this.now();
      // Renew our own live waiter before collecting leases whose processes disappeared.
      this.renew(token);
      this.sql("DELETE FROM api_requests WHERE expires < ?").run(now);
      const request = this.sql("SELECT * FROM api_requests WHERE token=?").get(token) as any;
      if (!request) throw new Error("API admission lease expired");
      const state = this.state(request.resource);
      if (request.state === "active") return { admitted: true, wait_ms: 0, state };
      const active = Number((this.sql("SELECT count(*) AS n FROM api_requests WHERE resource=? AND state='active'").get(request.resource) as any).n);
      const limits = this.operatingLimits(request.resource);
      const first = this.sql("SELECT token FROM api_requests WHERE resource=? AND state='waiting' ORDER BY ticket LIMIT 1").get(request.resource) as any;
      const until = Math.max(state.cooldown_until, state.next_start);
      if (first?.token !== token || active >= Math.min(state.cap, limits.concurrency) || now < until) {
        let waitMs = Math.max(RATE_WAIT_POLICY.occupied_poll_ms, until - now);
        const gap = Math.max(state.gap_ms, limits.min_gap_ms);
        if (gap > 0 && active < Math.min(state.cap, limits.concurrency)) {
          // With free slots, schedule this FIFO position near its earliest start.
          // A fixed 100ms poll wastes configured 25ms start slots. Every wake-up
          // rechecks FIFO, capacity and cooldown; this estimate grants no permit.
          const ahead = Number((this.sql("SELECT count(*) AS n FROM api_requests WHERE resource=? AND state='waiting' AND ticket<?")
            .get(request.resource, request.ticket) as any).n);
          waitMs = Math.max(1, Math.max(0, until - now) + ahead * gap);
        }
        return { admitted: false, wait_ms: Math.min(RATE_WAIT_POLICY.max_poll_ms, waitMs), state };
      }
      this.sql("UPDATE api_requests SET state='active' WHERE token=?").run(token);
      this.sql("UPDATE api_resources SET next_start=? WHERE resource=?").run(now + Math.max(state.gap_ms, limits.min_gap_ms), request.resource);
      return { admitted: true, admitted_at_ms: now, wait_ms: 0, state };
    });
  }
  limited(token: string, retryAfter?: string | null): RateState {
    return this.transaction(() => {
      const now = this.now();
      const r = this.sql("SELECT * FROM api_requests WHERE token=?").get(token) as any;
      if (!r) throw new Error("Missing API request while recording rate limit");
      const s = this.state(r.resource);
      const active = Number((this.sql("SELECT count(*) AS n FROM api_requests WHERE resource=? AND state='active'").get(r.resource) as any).n);
      // A burst of rejected in-flight requests is one congestion episode, not N halvings.
      const newEpisode = now >= s.cooldown_until;
      const cap = newEpisode ? Math.max(1, Math.floor(Math.min(s.cap, Math.max(1, active)) / 2)) : s.cap;
      const gap = newEpisode ? Math.min(RATE_POLICY.max_gap_ms, Math.max(RATE_POLICY.first_gap_ms, s.gap_ms * 2)) : s.gap_ms;
      const penalties = s.penalties + Number(newEpisode);
      const cooldown = Math.max(s.cooldown_until, now + retryAfterMs(retryAfter, now),
        now + Math.min(RATE_POLICY.max_cooldown_ms, RATE_POLICY.first_cooldown_ms * 2 ** Math.min(4, Math.max(0, penalties - 1))));
      this.sql("UPDATE api_resources SET cap=?,gap_ms=?,cooldown_until=?,last_limit=?,successes=0,penalties=? WHERE resource=?")
        .run(cap, gap, cooldown, now, penalties, r.resource);
      const next = this.state(r.resource);
      this.event(r, "rate_limited", next);
      return next;
    });
  }
  release(token: string, success = false) {
    this.transaction(() => {
      const r = this.sql("SELECT * FROM api_requests WHERE token=?").get(token) as any;
      if (!r) return;
      this.sql("DELETE FROM api_requests WHERE token=?").run(token);
      if (!success || r.state !== "active") return;
      const s = this.state(r.resource); const now = this.now();
      const ceiling = this.operatingLimits(r.resource).concurrency;
      const successes = s.successes + 1;
      if ((s.cap < ceiling || s.gap_ms > 0) && successes >= RATE_POLICY.recovery_successes &&
          now >= s.cooldown_until && now - Math.max(s.last_limit, s.last_recovery) >= RATE_POLICY.recovery_ms) {
        const gap = s.gap_ms <= RATE_POLICY.first_gap_ms ? 0 : Math.floor(s.gap_ms / 2);
        const cap = Math.min(ceiling, s.cap + 1);
        this.sql("UPDATE api_resources SET cap=?,gap_ms=?,last_recovery=?,successes=0,penalties=? WHERE resource=?")
          .run(cap, gap, now, cap === ceiling && gap === 0 ? 0 : s.penalties, r.resource);
        this.event(r, "recovering", this.state(r.resource));
      } else this.sql("UPDATE api_resources SET successes=? WHERE resource=?").run(successes, r.resource);
    });
  }
  private event(r: any, kind: string, details: RateState | Record<string,unknown>) {
    this.sql("INSERT INTO api_events(at_ms,resource,owner,run_id,kind,details_json) VALUES(?,?,?,?,?,?)")
      .run(this.now(), r.resource, r.owner, r.run_id, kind, JSON.stringify(details));
  }
  snapshot() {
    return {
      policy: RATE_POLICY,
      wait_policy: RATE_WAIT_POLICY,
      source_limits: [WIKIMEDIA_API_LIMIT],
      resource_limits: this.sql('SELECT * FROM api_resource_limits ORDER BY resource').all(),
      resources: this.sql("SELECT * FROM api_resources ORDER BY resource").all(),
      requests: this.sql("SELECT resource,owner,run_id,state,count(*) AS count FROM api_requests WHERE expires>=? GROUP BY resource,owner,run_id,state").all(this.now()),
      events: this.sql("SELECT * FROM api_events ORDER BY id DESC LIMIT 30").all(),
    };
  }
  async acquire(resource: string, trace?: RateTrace,signal?:AbortSignal): Promise<Permit> {
    signal?.throwIfAborted();
    const owner = userInfo().username;
    const runId = projectEnv("FABENCH_ACTIVE_RUN_ID") ?? projectEnv("FABENCH_RESULTS_DIR") ?? `pid:${process.pid}`;
    const token = this.enqueue(resource, owner, runId); const started = this.now();
    let lastNotice = 0;
    let admittedAt: number | undefined;
    try {
      while (true) {
        signal?.throwIfAborted();
        const admitted = this.tryAdmit(token);
        if (admitted.admitted) { admittedAt = admitted.admitted_at_ms; break; }
        if (this.now() - lastNotice >= 30_000) {
          trace?.({ type: "shared_rate_wait", data: { waited_ms: this.now() - started, ...admitted.state } });
          lastNotice = this.now();
        }
        await abortablePause(admitted.wait_ms,undefined,{signal});
      }
    } catch (error) { this.release(token); throw error; }
    let released = false;
    const controller = new AbortController();
    const heartbeat = setInterval(() => { try { this.renew(token); } catch (error) {
      controller.abort(new Error("Shared API admission lease renewal failed"));
    } }, 30_000);
    heartbeat.unref();
    trace?.({ type: "shared_rate_admitted", data: { resource, admitted_at_ms: admittedAt, waited_ms: this.now() - started } });
    return {
      signal: controller.signal,
      limited: retryAfter => {
        const state = this.limited(token, retryAfter);
        trace?.({ type: "shared_rate_limited", data: { ...state, owner, run_id: runId } });
        console.error(`[shared-rate] ${resource} cap=${state.cap} gap_ms=${state.gap_ms} cooldown_until=${new Date(state.cooldown_until).toISOString()}`);
      },
      release: success => { if (released) return; released = true; clearInterval(heartbeat); this.release(token, success); },
    };
  }
}

let singleton: SharedRateLimiter | undefined;
export function sharedRateLimiter(): SharedRateLimiter | undefined {
  const path = projectEnv("FABENCH_API_ADMISSION_DB");
  if (!path) {
    if (projectEnv("FABENCH_SHARED_LIFECYCLE") === "1") throw new Error("Shared experiments require API admission; use run-shared-experiment.sh");
    return undefined;
  }
  return singleton ??= new SharedRateLimiter(path);
}
