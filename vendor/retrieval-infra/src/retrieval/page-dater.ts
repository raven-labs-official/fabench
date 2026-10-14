import {timingSpan,emitTiming,type TimingEvent} from '../observability/timeline.js';
/**
 * Fetch pages and establish their publication dates, by shelling out to htmldate.
 *
 * Dating and extraction are evidence for the caller. Strict date mode rejects unknown
 * dates; content mode sends recovered text to a separate temporal-availability review.
 * Fetch success alone never proves the complete page existed at the historical anchor.
 *
 * Python because htmldate is the reference implementation and reimplementing its cascade in
 * TypeScript would be reimplementing the part most likely to be subtly wrong. Measured on 495
 * URLs drawn evenly across the corpus's eleven months: four hand-written patterns date 82.8%
 * of fetched pages, htmldate 92.3% with its guessing stage off.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RetrievalInfrastructureError } from "./infrastructure-error.js";

const DEFAULT_READER_TIMEOUT_SECONDS = 30;
const DEFAULT_PREFLIGHT_GRACE_MS = 5_000;
const HELPER_STDERR_LIMIT_BYTES = 512 * 1024;

/** Per-helper operating settings; cross-user API admission still applies. */
export interface PageAcquisitionOptions {
  fetchConcurrency?: number;
  readerConcurrency?: number;
  readerRpm?: number;
  dispatchConcurrency?: number;
}
export function pageAcquisitionPolicy(options: PageAcquisitionOptions = {}, env = process.env) {
  const integer = (name: string, explicit: number | undefined, fallback: number) => {
    const value = explicit ?? (env[name]?.trim() ? Number(env[name]) : fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
    return value;
  };
  return {
    fetch_concurrency: integer('FETCH_CONCURRENCY', options.fetchConcurrency, 48),
    reader_concurrency: integer('JINA_CONCURRENCY', options.readerConcurrency, 16),
    reader_rpm: integer('JINA_RPM', options.readerRpm, 400),
    dispatch_concurrency: integer('PAGE_DATER_DISPATCH_CONCURRENCY', options.dispatchConcurrency, 64),
  };
}

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  const value = raw == null || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive number`);
  return value;
}

export interface DatedPage {
  url: string;
  /** null when no page date could be established; admission depends on the caller policy. */
  date: string | null;
  title: string;
  text: string;
  text_extraction?: {
    raw_text_chars: number;
    cleaned_text_chars: number;
    inline_media_removed: number;
    delivered_chars: number;
    truncated: boolean;
  };
  /** Why it failed, for the run archive: "HTTP 403", "no date in page", "timeout". */
  why: string;
  /** Acquisition path that produced this document. */
  source?: "direct" | "reader" | "browser";
  attempts?: Record<string, unknown>[];
  browser_policy?: string;
  lastmod?: string | null;
  /** Direct response metadata; Reader fallback can replace the extracted text. */
  content_type?: string;
  response_bytes_read?: number;
  response_truncated?: boolean;
  /** End-to-end direct + fallback latency reported by the helper. */
  ms?: number;
  final_url?: string;
  published_date?: string | null;
  quality_error?: string;
  captures?: { sha256: string; bytes: number; path: string; kind: string; truncated: boolean }[];
  content_document?: {
    policy: string; extractor: string; body_sha256: string; usable: boolean;
    unusable_reason: string | null; complete: boolean; source_format: string;
    blocks: { id: string; kind: string; xpath: string | null; text: string; start: number; end: number; [key: string]: unknown }[];
    [key: string]: unknown;
  };
}

export interface DaterStats {
  /**
   * Failure text → count, top few reported with the run.
   *
   * The buckets below are a regex over `why`, which answers "how many were blocked" but not
   * "blocked by what". One run reported 233 reader throttles that could not be reproduced
   * afterwards at the same rate, and a boolean match had nothing more to say about it.
   */
  whyCounts?: Record<string, number>;
  requested: number;
  fetched: number;
  /** Fetched but carrying no establishable date. */
  undated: number;
  blocked: number;
  /** Recovered by the reader after a direct fetch was refused. */
  viaReader: number;
  viaBrowser: number;
  /**
   * Reader attempts refused for going too fast.
   *
   * Separated from other reader failures because the two call for opposite responses. Measured
   * alone, the reader recovered 18 of 19 blocked URLs; measured inside an 8-question run it
   * recovered 12 of 94. A gap that large is either throttling — fixable by slowing down — or
   * those particular hosts being genuinely unreachable, which is not fixable at all. The
   * aggregate cannot tell them apart, so it is counted here.
   */
  readerThrottled: number;
  /** False after the helper fails; future requests reject instead of silently returning []. */
  helperHealthy: boolean;
  helperFailureCode: string | null;
  helperFailure: string | null;
  helperDiagnostics?: {
    stderrPath?: string;
    sha256?: string;
    retainedBytes: number;
    totalBytes: number;
    truncated: boolean;
    archiveError?: string;
  };
  readerEnabled: boolean;
  readerPreflightPassed: boolean | null;
  readerPreflightHttpStatus: number | null;
  readerPreflightError: string | null;
}

interface PendingRequest {
  timing:(event:TimingEvent)=>void;
  expectedResults: number;
  ping: boolean;
  resolve: (results: DatedPage[]) => void;
  reject: (error: RetrievalInfrastructureError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PageDater {
  private readonly stats: DaterStats = {
    requested: 0,
    fetched: 0,
    undated: 0,
    blocked: 0,
    viaReader: 0,
    viaBrowser: 0,
    readerThrottled: 0,
    helperHealthy: true,
    helperFailureCode: null,
    helperFailure: null,
    readerEnabled: false,
    readerPreflightPassed: null,
    readerPreflightHttpStatus: null,
    readerPreflightError: null,
  };
  private readonly cache = new Map<string, DatedPage>();
  private readonly inFlight = new Map<string, Promise<DatedPage | undefined>>();
  private readonly readerTimeoutSeconds: number;
  private readonly preflightGraceMs: number;
  private readonly preflightTimeoutMs: number;
  private readonly acquisition: ReturnType<typeof pageAcquisitionPolicy>;

  /**
   * @param useReader route refused fetches through the reader fallback. ON by default,
   *   because the pages it recovers are not a random third of the web: measured on 20 blocked
   *   URLs it returned text for 18 and a publication date for 18, and the blocked set was
   *   dominated by the public-radio stations (kbia, cpr, kyuk, wrkf, publicradiotulsa) through
   *   which AP and NPR copy reaches this corpus. Losing them is a systematic hole in exactly
   *   the sources that matter, so the default is to close it.
   *
   *   What it costs: a third party in the fetch path, markdown rather than the original HTML,
   *   and a date that comes from the reader's own header rather than from htmldate — a
   *   different and less inspectable provenance. `--reader 0` turns it off, and `via_reader`
   *   in the run counters says how many documents came through it.
   */
  constructor(
    private readonly useReader = true,
    // Never depend on /tmp for a benchmark dependency. Production runs should set this to a
    // persistent team venv; local development may use a PATH-managed python3.
    private readonly python = process.env.HTMLDATE_PYTHON ?? "python3",
    private readonly script = new URL("../../tools/date-and-text.py", import.meta.url).pathname,
    private readonly timeoutMs = 120_000,
    private readonly contentOptions?: { policy: 'article-blocks-tables-v1'; rawDirectory: string; browser?: boolean },
    acquisitionOptions: PageAcquisitionOptions = {},
  ) {
    this.acquisition = pageAcquisitionPolicy(acquisitionOptions);
    if (contentOptions && !contentOptions.rawDirectory.trim()) throw new Error('rawDirectory is required for article extraction');
    // One timeout source governs both sides of the helper protocol. The Node deadline is the
    // exact reader request timeout plus a small grace period for Python to catch a socket
    // timeout, serialize the verdict, and flush stdout. Previously Node gave up at 10s while
    // Python was allowed to wait 25s, so a healthy-but-slow Jina call killed the whole arm.
    this.readerTimeoutSeconds = positiveNumber(
      "READER_TIMEOUT_S",
      process.env.READER_TIMEOUT_S,
      DEFAULT_READER_TIMEOUT_SECONDS,
    );
    this.preflightGraceMs = positiveNumber(
      "PAGE_DATER_PREFLIGHT_GRACE_MS",
      process.env.PAGE_DATER_PREFLIGHT_GRACE_MS,
      DEFAULT_PREFLIGHT_GRACE_MS,
    );
    this.preflightTimeoutMs =
      this.readerTimeoutSeconds * 1_000 + this.preflightGraceMs + (this.contentOptions?.browser ? 45_000 : 0);
  }

  configuration() {
    return {
      python: this.python,
      script: this.script,
      timeout_ms: this.timeoutMs,
      reader_timeout_seconds: this.readerTimeoutSeconds,
      preflight_grace_ms: this.preflightGraceMs,
      preflight_timeout_ms: this.preflightTimeoutMs,
      timeout_source: "READER_TIMEOUT_S + PAGE_DATER_PREFLIGHT_GRACE_MS",
      reader: this.useReader,
      concurrency: this.acquisition,
      content: this.contentOptions ?? { policy: 'visible-text-v1' },
      acquisition_policy: this.contentOptions ? 'article-direct-browser-reader-v1' : 'legacy-direct-reader',
      http_deadline_policy: 'urllib-isolated-total-deadline-v1',
      extraction_revision: this.contentOptions ? 'article-time-blocks-v2' : null,
      helper_admission: 'bounded-before-ipc-v1',
      browser: this.contentOptions?.browser ? { policy: 'crawl4ai-rendered-dom-v1', per_helper_concurrency: 2, deadline_seconds: 45 } : false,
    };
  }

  private child?: ReturnType<typeof spawn>;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private fatalError?: RetrievalInfrastructureError;
  private closing = false;
  private stderr = "";
  private activeRequests = 0;
  private readonly requestQueue: Array<{resolve: () => void; reject: (error: Error) => void}> = [];

  private acquireRequest(): Promise<void> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.activeRequests < this.acquisition.dispatch_concurrency) {
      this.activeRequests++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => this.requestQueue.push({resolve, reject}));
  }

  private releaseRequest(): void {
    const next = this.requestQueue.shift();
    if (next) next.resolve();
    else this.activeRequests--;
  }

  /**
   * Keep HTTP status codes; strip only the digits that are not one.
   *
   * Stripping every digit collapsed "reader HTTP 429" and "reader HTTP 403" into one bucket,
   * which is the opposite of useful: the whole point of counting reasons was to tell rate
   * limiting from refusal, and those two differ only in that number.
   */
  private note(why: string): void {
    if (!why) return;
    const k = why.replace(/\b(?!\d{3}\b)\d+\b/g, "N").slice(0, 56);
    this.why.set(k, (this.why.get(k) ?? 0) + 1);
  }

  private readonly why = new Map<string, number>();

  snapshot(): DaterStats {
    return {
      ...this.stats,
      readerEnabled: this.useReader,
      helperHealthy: !this.fatalError,
      helperFailureCode: this.fatalError?.code ?? null,
      helperFailure: this.fatalError?.message ?? null,
      whyCounts: Object.fromEntries([...this.why].sort((a, b) => b[1] - a[1]).slice(0, 5)),
    };
  }

  /**
   * Start the real helper and, when enabled, perform one authenticated Jina read. A mixed
   * None/Frozen/Web run does this before any paid forecast so an expired key or empty balance
   * cannot silently turn Web-filter into an empty-search treatment.
   */
  async assertReady(): Promise<void> {
    await this.request([], true, this.preflightTimeoutMs);
  }

  async fetchMany(urls: readonly string[]): Promise<DatedPage[]> {
    const fresh = [...new Set(urls)].filter(url => !this.cache.has(url) && !this.inFlight.has(url));
    if (fresh.length) {
      const batch = this.fetchFresh(fresh);
      for (const url of fresh) {
        const pending = batch.then(() => this.cache.get(url)).finally(() => this.inFlight.delete(url));
        this.inFlight.set(url, pending);
      }
    }
    const pages = await Promise.all(urls.map(url => this.cache.get(url) ?? this.inFlight.get(url)));
    return pages.filter((page): page is DatedPage => Boolean(page));
  }

  private async fetchFresh(urls: readonly string[]): Promise<DatedPage[]> {
    const fresh = [...new Set(urls)].filter((u) => !this.cache.has(u));
    if (fresh.length) {
      this.stats.requested += fresh.length;
      const fetched = await this.request(fresh);
      const fatalReader = fetched.find((p) => /reader HTTP (401|402)\b/i.test(p.why));
      if (fatalReader) {
        throw this.fail(
          "reader_unavailable",
          `Jina reader became unavailable during the run (${fatalReader.why.slice(0, 220)})`,
        );
      }
      if (fetched.some(p=>p.why.includes("reader API admission unavailable")))
        throw this.fail("api_admission_unavailable", "Shared reader admission failed; stopping rather than serving incomplete evidence");
      for (const p of fetched) {
        if (p.source === 'browser') this.stats.viaBrowser++;
        if (p.date) {
          this.stats.fetched++;
          if (p.source === "reader") this.stats.viaReader++;
          this.note(p.why);
        } else if (/reader HTTP 429/.test(p.why)) {
          this.note(p.why);
          this.stats.readerThrottled++;
          this.stats.blocked++;
        }
        else if (/^HTTP 4|^HTTP 5/.test(p.why)) {
          this.stats.blocked++;
          this.note(p.why);
        } else {
          this.stats.undated++;
          this.note(p.why);
        }
        this.cache.set(p.url, p);
      }
    }
    return urls.map((u) => this.cache.get(u)).filter((p): p is DatedPage => !!p);
  }

  /**
   * One long-lived helper for the whole run, not one per batch.
   *
   * Per-batch processes cost 0.4s importing htmldate every time (measured), and each got its
   * own copy of the helper's reader semaphore — so the "8 concurrent" limit became 8 x fifty
   * live processes, and the throttling that followed was self-inflicted. With one process the
   * limit means what it says, and FETCH_CONCURRENCY is the run's whole budget.
   */
  private ensureChild() {
    if (this.fatalError) throw this.fatalError;
    if (this.child) return this.child;
    this.closing = false;
    this.stderr = "";
    let diagnosticStderr: Buffer = Buffer.alloc(0);
    let stderrBytes = 0;
    const child = spawn(this.python, [this.script], {
      env: {
        ...process.env,
        PYTHONFAULTHANDLER: '1',
        FABENCH_NODE_EXECUTABLE: process.execPath,
        FABENCH_TSX_LOADER: new URL(import.meta.resolve("tsx")).pathname,
        FABENCH_API_BRIDGE: new URL("../../tools/api-admission-bridge.ts",import.meta.url).pathname,
        READER_TIMEOUT_S: String(this.readerTimeoutSeconds),
        FABENCH_CONTENT_POLICY: this.contentOptions?.policy ?? '',
        FABENCH_RAW_PAGES_DIR: this.contentOptions?.rawDirectory ?? '',
        FABENCH_BROWSER_FALLBACK: this.contentOptions?.browser ? '1' : '0',
        JINA_READER: this.useReader ? '1' : '0',
        FETCH_CONCURRENCY: String(this.acquisition.fetch_concurrency),
        JINA_CONCURRENCY: String(this.acquisition.reader_concurrency),
        JINA_RPM: String(this.acquisition.reader_rpm),
        PAGE_DATER_DISPATCH_CONCURRENCY: String(this.acquisition.dispatch_concurrency),
      },
      stdio: ["pipe", "pipe", "pipe"] as const,
    });
    child.stderr!.on("data", (data) => {
      this.stderr = (this.stderr + String(data)).slice(-2_000);
      const chunk = Buffer.from(data);
      stderrBytes += chunk.length;
      const combined = Buffer.concat([diagnosticStderr, chunk]);
      diagnosticStderr = Buffer.from(combined.subarray(-HELPER_STDERR_LIMIT_BYTES));
    });
    let buf = "";
    child.stdout!.on("data", (d) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as {
            id: number;
            admission_wait?: boolean;
            timing?:TimingEvent;
            ok?: boolean;
            reader?: {
              enabled?: boolean;
              ok?: boolean;
              http_status?: number | null;
              error?: string | null;
            };
            browser?: { enabled: boolean; ok: boolean; error?: string };
            results?: DatedPage[];
          };
          const pending = this.pending.get(msg.id);
          if (!pending) continue;
          if(msg.timing){pending.timer.refresh();pending.timing(msg.timing);continue;}
          // The helper is alive but queued behind the team's shared API quota. Socket
          // timeouts still apply once admitted; queue time must not kill the web arm.
          if (msg.admission_wait === true) { pending.timer.refresh(); continue; }
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (pending.ping) {
            if (this.contentOptions?.browser && msg.browser?.ok !== true) {
              pending.reject(this.fail('browser_preflight_failed', `Crawl4AI browser unavailable: ${msg.browser?.error ?? 'no browser proof'}`));
              continue;
            }
            this.stats.readerEnabled = msg.reader?.enabled === true;
            this.stats.readerPreflightPassed = msg.reader?.ok ?? null;
            this.stats.readerPreflightHttpStatus = msg.reader?.http_status ?? null;
            this.stats.readerPreflightError = msg.reader?.error ?? null;
            if (msg.ok !== true) {
              pending.reject(
                this.fail(
                  msg.reader?.enabled ? "reader_preflight_failed" : "protocol_error",
                  msg.reader?.enabled
                    ? `Jina reader preflight failed${msg.reader.http_status ? ` (HTTP ${msg.reader.http_status})` : ""}${msg.reader.error ? `: ${msg.reader.error}` : ""}`
                    : `page-dater helper did not acknowledge its health check`,
                ),
              );
            } else {
              pending.resolve([]);
            }
            continue;
          }
          const results = msg.results ?? [];
          if (results.length !== pending.expectedResults) {
            pending.reject(
              this.fail(
                "incomplete_batch",
                `page-dater helper returned ${results.length}/${pending.expectedResults} page records`,
              ),
            );
          } else {
            pending.resolve(results);
          }
        } catch (error) {
          this.fail(
            "protocol_error",
            `page-dater helper emitted malformed output`,
            error,
          );
        }
      }
    });
    // A dead helper invalidates the treatment, not just one URL. Reject every caller so the
    // experiment scheduler can open the Web arm circuit instead of paying for empty searches.
    child.on("error", (error) => {
      this.fail(
        "spawn_error",
        `page-dater helper failed to start (${this.python})`,
        error,
      );
    });
    child.on("close", (code, signal) => {
      this.child = undefined;
      if (diagnosticStderr.length && this.contentOptions?.rawDirectory) {
        const diagnostics: NonNullable<DaterStats['helperDiagnostics']> = {
          retainedBytes: diagnosticStderr.length,
          totalBytes: stderrBytes,
          truncated: stderrBytes > diagnosticStderr.length,
        };
        try {
          mkdirSync(this.contentOptions.rawDirectory, { recursive: true });
          const sha256 = createHash('sha256').update(diagnosticStderr).digest('hex');
          const path = join(this.contentOptions.rawDirectory, `helper-${child.pid ?? 'unstarted'}-${sha256}.stderr.log`);
          writeFileSync(path, diagnosticStderr, { mode: 0o640 });
          Object.assign(diagnostics, { stderrPath: path, sha256 });
        } catch (error) {
          // Preserve the original native/helper failure even if its archive is unavailable.
          diagnostics.archiveError = error instanceof Error ? error.message : String(error);
        }
        this.stats.helperDiagnostics = diagnostics;
      }
      if (this.closing || this.fatalError) return;
      this.fail(
        "helper_exit",
        `page-dater helper exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`,
      );
    });
    this.child = child;
    return child;
  }

  private fail(
    code: string,
    message: string,
    cause?: unknown,
  ): RetrievalInfrastructureError {
    if (!this.fatalError) {
      const stderr = this.stderr.trim();
      this.fatalError = new RetrievalInfrastructureError(
        "page-dater",
        code,
        `${message}${stderr ? `: ${stderr.slice(-400)}` : ""}`,
        cause === undefined ? undefined : { cause },
      );
      const child = this.child;
      this.child = undefined;
      child?.stdin?.destroy();
      child?.kill();
    }
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(this.fatalError);
    }
    for (const queued of this.requestQueue.splice(0)) queued.reject(this.fatalError);
    return this.fatalError;
  }

  private async request(
    urls: readonly string[],
    ping = false,
    timeoutMs = this.timeoutMs,
  ): Promise<DatedPage[]> {
    // Bound requests before writing the pipe. Python can acknowledge only requests
    // it has read; an unbounded stdin backlog cannot emit queue heartbeats.
    const span=timingSpan('page.helper.admission');span.queued();
    try {
      await this.acquireRequest();
    } catch (error) { span.end(error); throw error; }
    span.admitted();span.start();
    try {
      if (this.fatalError) throw this.fatalError;
      const result = await span.run(() => this.sendRequest(urls, ping, timeoutMs));
      span.end();
      return result;
    } catch (error) { span.end(error); throw error; }
    finally { this.releaseRequest(); }
  }

  private sendRequest(urls: readonly string[], ping: boolean, timeoutMs: number): Promise<DatedPage[]> {
    const id = this.nextId++;
    const span=timingSpan('page.helper');span.queued();span.admitted();span.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.fail(
          "helper_timeout",
          `page-dater helper request ${id} made no progress within ${timeoutMs}ms (pending=${this.pending.size}, queued=${this.requestQueue.length})`,
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        expectedResults: urls.length,
        ping,
        resolve:results=>{span.end();resolve(results);},
        reject:error=>{span.end(error);reject(error);},
        timing:event=>span.run(()=>emitTiming(event)),
        timer,
      });
      try {
        const child = this.ensureChild();
        child.stdin!.write(
          JSON.stringify({ id, urls, timing:span.context, ...(ping ? { ping: true } : {}) }) + "\n",
          (error) => {
            if (error)
              this.fail(
                "stdin_error",
                `could not send a request to the page-dater helper`,
                error,
              );
          },
        );
      } catch (error) {
        const infrastructureError =
          error instanceof RetrievalInfrastructureError
            ? error
            : this.fail(
                "spawn_error",
                `page-dater helper failed to start (${this.python})`,
                error,
              );
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(infrastructureError);
        }
      }
    });
  }

  /** Let the helper exit; without this the process keeps Node alive after the run. */
  close(): void {
    this.closing = true;
    if (this.activeRequests || this.requestQueue.length)
      this.fail('helper_closed', 'page-dater closed with outstanding requests');
    this.child?.stdin?.end();
    this.child = undefined;
  }
}
