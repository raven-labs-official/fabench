/**
 * Web search providers, behind one interface so the source is a configuration choice.
 *
 * Every provider here returns the same thing: a list of URLs with titles. That is all the
 * pipeline needs — publication dates and article text come from fetching the page and running
 * htmldate (see PageDater), not from the search service. Providers that also return snippets
 * or dates are welcome to; nothing downstream depends on them.
 *
 * WHY NOT THE CLI. The previous implementation spawned `claude --print --allowed-tools
 * WebSearch` per query and cost ~44 seconds. Profiling showed where that went: process start
 * is 0.2s, the search itself about 0.7s, and everything else is a three-turn agent loop —
 * decide what to search, digest the results, then re-serialise them as JSON at 67 tokens per
 * second. The middle model is redundant here: the forecasting agent has ALREADY written the
 * query by the time this is called, so a second model deciding what to search adds a full
 * inference round-trip and buys nothing.
 */

import { getEnvKey } from "../llm/load-env.js";
import { apiResource, sharedRateLimiter, retryAfterMs, type Permit } from "../llm/shared-rate-limit.js";
import { timingSpan } from '../observability/timeline.js';
import { classifyProviderHttpError, ProviderApiError } from "../llm/openai-compatible.js";
import { createHash } from "node:crypto";

export interface SearchResult {
  url: string;
  title: string;
  snippet?: string;
  /**
   * The engine's own publication date, when it reports one ("Feb 18, 2026").
   *
   * Not trusted as the admission decision — that still comes from fetching the page — but
   * usable to DISCARD without fetching. Engines report first publication while we test last
   * modification, and last-modified >= published, so an engine date after the anchor proves
   * the page is after the anchor. The converse proves nothing, so those still get fetched.
   */
  date?: string;
}

export interface SearchProvider {
  readonly name: string;
  /**
   * @param asOf when supplied, the provider SHOULD restrict results to on-or-before this
   *   anchor if it can (Serper does, via Google's `tbs` date range). Optional and best-effort:
   *   a provider that cannot date-restrict ignores it, and the downstream htmldate gate remains
   *   the real admission test — this only improves the candidate set the engine returns.
   */
  search(query: string, n: number, asOf?: string): Promise<SearchResult[]>;
  /** Requests issued and failed, for the run archive. */
  stats(): { requests: number; failed: number; http_attempts?: number; retries?: number;
    http_errors?: Record<string, number>; transport_policy?: typeof SERPER_TRANSPORT_POLICY };
}

/** Numeric counters can be included in both legacy and quality backend archives. */
export function searchTransportCounters(provider: SearchProvider): Record<string, number> {
  const stats = provider.stats();
  return stats.http_attempts === undefined ? {} : {
    search_http_attempts: stats.http_attempts, search_http_retries: stats.retries ?? 0,
    ...Object.fromEntries(Object.entries(stats.http_errors ?? {}).map(([status, count]) => [`search_http_${status}`, count])),
  };
}

/** A small live request before forecast spending; its results never enter model context. */
export async function assertSearchProviderReady(provider: SearchProvider, record: (receipt: Record<string, unknown>) => void) {
  const started = Date.now();
  const receipt = { schema:'raven.search-readiness.v1',provider:provider.name,query:'Wikipedia',n:1,started_at_utc:new Date(started).toISOString() };
  try {
    const results = await provider.search(receipt.query,receipt.n);
    record({...receipt,ok:true,elapsed_ms:Date.now()-started,result_count:results.length});
  } catch (error) {
    record({...receipt,ok:false,elapsed_ms:Date.now()-started,error:{
      name:error instanceof Error?error.name:'Error',message:error instanceof Error?error.message:String(error),
    }});
    throw error;
  }
}

/** Keep only diagnostic fields, never an arbitrary response or reflected credential. */
export function braveHttpError(status: number, body: string, credential: string) {
  let code: string | undefined,detail='Search request rejected';
  try {
    const error=JSON.parse(body)?.error;
    if(typeof error?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code))code=error.code;
    if(typeof error?.detail==='string')detail=(credential?error.detail.replaceAll(credential,'[REDACTED]'):error.detail).slice(0,400);
    const meta=error?.meta;
    if(Number.isFinite(meta?.usage_limit)&&Number.isFinite(meta?.current_spend))
      detail+=` (usage_limit=${meta.usage_limit}, current_spend=${meta.current_spend})`;
  }catch{}
  if(credential){detail=detail.replaceAll(credential,'[REDACTED]');if(code?.includes(credential))code=undefined;}
  return classifyProviderHttpError('brave',status,JSON.stringify({error:{code,message:detail}}));
}

/** JSON response capture, excluding request headers and credentials. */
export interface SerperSearchCapture {
  endpoint: string;
  request: Record<string, unknown>;
  response: unknown;
  responseSha256: string;
  observedAtUtc: string;
}

export function normalizeSerperResults(data: any, n: number): SearchResult[] {
  return (data.organic ?? []).filter((r:any)=>r.link).slice(0,n)
    .map((r:any)=>({url:r.link,title:r.title??'',snippet:r.snippet,date:r.date}));
}

const UA = "raven-bench/1.0";

/** Process-wide operating setting; account admission remains independently enforced. */
let searchConcurrency: number | undefined;
export function configureSearchHttpConcurrency(value?: number) {
  const requested = value ?? searchConcurrency ?? Number(process.env.SEARCH_CONCURRENCY ?? 16);
  if (!Number.isSafeInteger(requested) || requested < 1)
    throw new Error('Search HTTP concurrency must be a positive safe integer');
  if (searchConcurrency !== undefined && requested !== searchConcurrency)
    throw new Error('Search HTTP concurrency is fixed for this process; use a separate process for another setting');
  searchConcurrency = requested;
  return Object.freeze({ version: 'search-http-concurrency-v1', scope: 'process',
    max_in_flight: requested, permit_covers: 'shared-admission-and-http' });
}
let inFlight = 0;
const waiting: (() => void)[] = [];
async function gate<T>(fn: () => Promise<T>): Promise<T> {
  const policy = configureSearchHttpConcurrency();
  const queue = timingSpan('search.local_queue'); queue.queued();
  if (inFlight >= policy.max_in_flight) await new Promise<void>((r) => waiting.push(r));
  else inFlight++;
  queue.admitted(); queue.start(); queue.end();
  try {
    return await fn();
  } finally {
    // Transfer the occupied permit directly, including after a failed request.
    const next = waiting.shift();
    if (next) next(); else inFlight--;
  }
}

export const SERPER_TRANSPORT_POLICY = Object.freeze({
  version: 'serper-transient-retry-v1', maxAttempts: 3,
  backoffMs: Object.freeze([1000, 2000]), maxRetryAfterMs: 30_000,
});

export abstract class HttpProvider implements SearchProvider {
  abstract readonly name: string;
  protected requests = 0;
  protected failed = 0;
  private httpAttempts = 0;
  private retries = 0;
  private readonly httpErrors: Record<string, number> = {};
  // Generous: the budget above keeps the queue short, so a slow answer is the provider being
  // slow rather than us being backed up, and killing it at 20s only loses the work.
  constructor(protected readonly timeoutMs = Number(process.env.SEARCH_TIMEOUT_MS ?? 45_000)) {}

  stats() {
    return { requests: this.requests, failed: this.failed, ...(this.name === 'serper' ? {
      http_attempts: this.httpAttempts, retries: this.retries,
      http_errors: { ...this.httpErrors }, transport_policy: SERPER_TRANSPORT_POLICY,
    } : {}) };
  }

  protected async post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
    this.requests++;
    const attempts = this.name === 'serper' ? SERPER_TRANSPORT_POLICY.maxAttempts : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let retryAfter = 0;
      try {
        return await gate(async () => {
          const credential = Object.entries(headers).find(([k]) => ["authorization", "x-api-key", "x-subscription-token"].includes(k.toLowerCase()))?.[1].replace(/^Bearer\s+/i, "") ?? "anonymous";
          const queue = timingSpan('search.shared_queue'); queue.queued();
          let permit: Permit | undefined;
          try {
            permit = await sharedRateLimiter()?.acquire(apiResource(this.name, url, credential));
            queue.admitted(); queue.start(); queue.end();
          } catch (error) { queue.end(error); throw error; }
          let success = false;
          const span = timingSpan('search.http');
          span.start(); this.httpAttempts++;
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", "user-agent": UA, ...headers },
              body: JSON.stringify(body),
              signal: permit?.signal ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), permit.signal]) : AbortSignal.timeout(this.timeoutMs),
            });
            if (!res.ok) {
              const text = await res.text();
              const error = classifyProviderHttpError(this.name, res.status, text);
              retryAfter = retryAfterMs(res.headers.get('retry-after'));
              this.httpErrors[String(res.status)] = (this.httpErrors[String(res.status)] ?? 0) + 1;
              if (error.category === "rate_limited") permit?.limited(res.headers.get("retry-after"));
              throw error;
            }
            const data = await res.json(); success = true; span.end(); return data;
          } catch (error) { span.end(error); throw error; }
          finally { permit?.release(success); }
        });
      } catch (error) {
        // Serper search is retryable after an explicit transient HTTP response.
        // Unknown POST/network outcomes, auth, quota and malformed requests stay fatal.
        if (!(error instanceof ProviderApiError) || !error.retryable || attempt + 1 >= attempts || retryAfter > SERPER_TRANSPORT_POLICY.maxRetryAfterMs) {
          this.failed++; throw error;
        }
        this.retries++;
        const wait = Math.max(SERPER_TRANSPORT_POLICY.backoffMs[attempt] ?? 2000, retryAfter);
        const span = timingSpan('search.retry'); span.queued();
        await new Promise<void>(resolve => setTimeout(resolve, wait));
        span.admitted(); span.start(); span.end();
      }
    }
    throw new Error('Search transport attempts exhausted');
  }

  abstract search(query: string, n: number): Promise<SearchResult[]>;
}

/**
 * Anthropic's Messages API with the server-side web search tool.
 *
 * Same index the CLI path used — Anthropic's subprocessor disclosure names Brave Search as
 * the provider — so switching to this changes the speed without changing what comes back.
 * The model is forced to call the tool and the stream is abandoned as soon as the results
 * block arrives, which skips the prose the CLI path was paying for.
 *
 * `web_search_20250305` deliberately, not the newer variants: those default `allowed_callers`
 * to the code-execution sandbox, which routes the search through an extra hop.
 */
export class AnthropicSearchProvider extends HttpProvider {
  readonly name = "anthropic";
  constructor(
    private readonly apiKey: string,
    private readonly model = "claude-haiku-4-5",
  ) {
    super(60_000);
  }

  async search(query: string, n: number): Promise<SearchResult[]> {
    const data = await this.post(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
        tool_choice: { type: "tool", name: "web_search" },
        messages: [{ role: "user", content: `Search the web for: ${query}` }],
      },
    );
    const out: SearchResult[] = [];
    for (const block of data.content ?? []) {
      if (block.type !== "web_search_tool_result") continue;
      for (const r of block.content ?? []) {
        if (r.type === "web_search_result" && r.url) out.push({ url: r.url, title: r.title ?? "" });
      }
    }
    return out.slice(0, n);
  }
}

/** Serper — scraped Google SERPs. Fast and cheap; not an official Google interface. */
export class SerperProvider extends HttpProvider {
  readonly name = "serper";
  constructor(private readonly apiKey: string) {
    super();
  }

  async search(query: string, n: number, asOf?: string): Promise<SearchResult[]> {
    return (await this.searchWithCapture(query, n, asOf)).results;
  }

  async searchWithCapture(query: string, n: number, asOf?: string): Promise<{results:SearchResult[];capture:SerperSearchCapture}> {
    const body: Record<string, unknown> = { q: query, num: Math.min(n, 10) };
    // Restrict Google to results it dates on or before the anchor. Measured on run100b: the
    // default ranking is freshness-biased and ~75% of results were post-anchor, each one paying
    // for a fetch only to be discarded. `tbs=cdr:1,cd_max=<anchor>` makes Google surface
    // pre-anchor pages instead — verified live: with cd_max=2026-02-01 every result came back
    // dated before that day. It also moves the ranking closer to what was findable at the time.
    // Google's own date is imperfect, so the htmldate gate downstream still decides admission;
    // this only improves the candidate set, it does not replace the leakage check.
    if (asOf) {
      const [y, m, d] = asOf.slice(0, 10).split("-");
      if (y && m && d) body.tbs = `cdr:1,cd_max:${m}/${d}/${y}`;
    }
    const data = await this.post(
      "https://google.serper.dev/search",
      { "X-API-KEY": this.apiKey },
      body,
    );
    const results = normalizeSerperResults(data,n);
    return { results, capture: { endpoint:"https://google.serper.dev/search", request:body,
      response:data, responseSha256:createHash('sha256').update(JSON.stringify(data)).digest('hex'),
      observedAtUtc:new Date().toISOString() } };
  }
}

/**
 * Zhipu GLM's standalone search endpoint.
 *
 * The only provider surveyed that exposes search as its own endpoint rather than as a tool a
 * model must be persuaded to call, so there is no inference in the path at all.
 */
export class ZhipuSearchProvider extends HttpProvider {
  readonly name = "zhipu";
  constructor(
    private readonly apiKey: string,
    private readonly engine = "search_std",
  ) {
    super();
  }

  async search(query: string, n: number): Promise<SearchResult[]> {
    const data = await this.post(
      "https://open.bigmodel.cn/api/paas/v4/web_search",
      { authorization: `Bearer ${this.apiKey}` },
      { search_engine: this.engine, search_query: query, count: Math.min(n, 50) },
    );
    return (data.search_result ?? [])
      .filter((r: any) => r.link)
      .slice(0, n)
      .map((r: any) => ({ url: r.link, title: r.title ?? "", snippet: r.content }));
  }
}

function braveDate(value: string): string {
  const exact = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(exact))
    throw new Error("Brave expects a UTC date or timestamp");
  const date = new Date(exact);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== exact.slice(0, 10))
    throw new Error("Invalid Brave calendar date");
  return date.toISOString().slice(0, 10);
}

/** The fixed request policy is also recorded in Brave experiment conditions. */
export const BRAVE_SEARCH_CONFIG = Object.freeze({
  endpoint: "https://api.search.brave.com/res/v1/web/search",
  freshness_start: "1970-01-01",
  date_precision: "calendar-day",
  extra_snippets: true,
  result_filter: "web",
  text_decorations: false,
  country: "US",
  search_lang: "en",
  ui_lang: "en-US",
  safesearch: "moderate",
  spellcheck: false,
  count_limit: 20,
});

/** Direct Brave Web Search. Page age is engine metadata, not historical-version proof. */
export class BraveSearchProvider implements SearchProvider {
  readonly name = "brave";
  private requests = 0;
  private failed = 0;
  constructor(private readonly apiKey: string,
    private readonly timeoutMs = Number(process.env.SEARCH_TIMEOUT_MS ?? 45_000)) {}

  stats() { return { requests: this.requests, failed: this.failed }; }

  async search(query: string, n: number, asOf?: string): Promise<SearchResult[]> {
    if (!query.trim() || query.length > 600 || query.trim().split(/\s+/).length > 75) throw new Error("brave query must contain 1–600 characters and at most 75 words");
    if (!Number.isFinite(n) || n < 1) throw new Error("brave result count must be positive");
    const params = new URLSearchParams({ q: query, count: String(Math.min(Math.floor(n), BRAVE_SEARCH_CONFIG.count_limit)),
      extra_snippets: "true", result_filter: "web", text_decorations: "false", country: "US",
      search_lang: "en", ui_lang: "en-US", safesearch: "moderate", spellcheck: "false" });
    if (asOf) {
      const end = braveDate(asOf);
      if (end < BRAVE_SEARCH_CONFIG.freshness_start) throw new Error("brave anchor precedes supported freshness range");
      params.set("freshness", `${BRAVE_SEARCH_CONFIG.freshness_start}to${end}`);
    }
    // Hold the shared concurrency slot through response decoding, including timeout/error paths.
    return gate(async () => {
      this.requests++;
      let permit: Permit | undefined;
      let success = false;
      try {
        permit = await sharedRateLimiter()?.acquire(apiResource(this.name, BRAVE_SEARCH_CONFIG.endpoint, this.apiKey));
        const res = await fetch(`${BRAVE_SEARCH_CONFIG.endpoint}?${params}`, {
          headers: { accept: "application/json", "x-subscription-token": this.apiKey, "user-agent": UA },
          signal: permit?.signal ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), permit.signal]) : AbortSignal.timeout(this.timeoutMs), redirect: "error",
        });
        // Preserve the quota/error code while excluding arbitrary response fields and keys.
        if (!res.ok) {
          if (res.status === 429) permit?.limited(res.headers.get("retry-after"));
          throw braveHttpError(res.status,await res.text(),this.apiKey);
        }
        const data = await res.json() as any;
        if (!data || typeof data !== "object" || Array.isArray(data) || data.error || data.type === "ErrorResponse" ||
            (data.web === undefined && data.type !== "search") ||
            (data.web != null && !Array.isArray(data.web.results))) throw new Error("brave invalid response schema");
        success = true;
        return (data.web?.results ?? [])
          .filter((r: any) => r && typeof r.url === "string" && /^https?:\/\//i.test(r.url))
          .slice(0, Math.min(Math.floor(n), BRAVE_SEARCH_CONFIG.count_limit))
          .map((r: any) => ({
            url: r.url, title: typeof r.title === "string" ? r.title : "",
            snippet: [...new Set([r.description, ...(Array.isArray(r.extra_snippets) ? r.extra_snippets.slice(0, 5) : [])]
              .filter((v): v is string => typeof v === "string" && Boolean(v.trim())))].join("\n"),
            // `age` is relative to today's request, and page_fetched is crawler time. Neither
            // is a substitute for the engine's page date; missing page_age stays missing.
            date: typeof r.page_age === "string" && r.page_age.trim() ? r.page_age : undefined,
          }));
      } catch (error) {
        this.failed++;
        if(error instanceof ProviderApiError && error.providerId==='brave')throw error;
        if (error instanceof Error && /^brave (HTTP \d+|invalid response schema)$/.test(error.message)) throw error;
        throw new Error(`brave request failed (${error instanceof Error ? error.name : "unknown error"})`);
      } finally { permit?.release(success); }
    });
  }
}

/** Explicit selection includes Brave. Keep the established auto order stable. */
export const SEARCH_PROVIDERS = ["anthropic", "serper", "zhipu", "brave"] as const;
export const AUTO_SEARCH_PROVIDERS = ["anthropic", "serper", "zhipu"] as const;

/**
 * @param name one of SEARCH_PROVIDERS, or "auto" to pick the first whose key is present.
 */
/**
 * @param env override for tests. Keys are read through `getEnvKey`, which checks the process
 *   environment and then the repo `.env` — the same lookup the model clients use, so a key
 *   that works for `--llm glm` also works for `--search-provider zhipu` without being exported
 *   twice.
 */
export function createSearchProvider(name: string, env?: NodeJS.ProcessEnv): SearchProvider {
  const key = (k: string) => (env ? env[k]?.trim() || undefined : getEnvKey(k));
  const build = (n: string): SearchProvider | null => {
    switch (n) {
      case "anthropic": {
        const k = key("ANTHROPIC_API_KEY");
        return k ? new AnthropicSearchProvider(k, key("ANTHROPIC_SEARCH_MODEL") ?? "claude-haiku-4-5") : null;
      }
      case "serper": {
        const k = key("SERPER_API_KEY");
        return k ? new SerperProvider(k) : null;
      }
      case "zhipu": {
        const k = key("GLM_API_KEY") ?? key("ZHIPU_API_KEY");
        return k ? new ZhipuSearchProvider(k, key("ZHIPU_SEARCH_ENGINE") ?? "search_std") : null;
      }
      case "brave": {
        const k = key("BRAVE_API_KEY");
        return k ? new BraveSearchProvider(k) : null;
      }
      default:
        throw new Error(
          `unknown search provider "${n}"; expected one of ${SEARCH_PROVIDERS.join(", ")} or auto`,
        );
    }
  };

  if (name === "auto") {
    for (const n of AUTO_SEARCH_PROVIDERS) {
      const p = build(n);
      if (p) return p;
    }
    throw new Error(
      `no auto search provider configured. Set ANTHROPIC_API_KEY, SERPER_API_KEY or GLM_API_KEY; Brave requires explicit --search-provider brave and BRAVE_API_KEY`,
    );
  }
  const p = build(name);
  if (!p) throw new Error(`search provider "${name}" selected but its API key is not set`);
  return p;
}
