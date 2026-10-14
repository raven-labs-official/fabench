/**
 * Minimal stdio MCP adapter for FABench's time-isolated frozen corpus.
 *
 * This exists for harness probes. FABench's primary runner drives the same FrozenBackend
 * directly through OpenAI-style function calls; Codex CLI discovers tools through MCP.
 * Keeping this adapter thin lets a Codex-harness cell see the same search ranking, snippets,
 * full documents, result cap, and as-of gate without exposing the live web.
 */
import { appendFileSync } from "node:fs";
import { CorpusStore } from "../src/corpus/store.js";
import { FrozenBackend } from "../src/retrieval/search-backend.js";
import { projectEnv } from "../src/env-names.js";

const corpusPath = projectEnv("FABENCH_CORPUS_DB")?.trim();
const asOf = projectEnv("FABENCH_AS_OF")?.trim();
const tracePath = projectEnv("FABENCH_MCP_TRACE")?.trim();
const maxResults = Math.max(
  1,
  Number.parseInt(projectEnv("FABENCH_MAX_RESULTS_PER_SEARCH") ?? "20", 10) || 20,
);

// One server process serves one question, so this counts that question's search and fetch
// calls against the same shared budget the primary runner uses.
// 100 matches FABench's predictor budget; a harness may pass a different explicit value.
const maxToolCalls = Number.parseInt(projectEnv("FABENCH_MAX_TOOL_CALLS") ?? "100", 10);
if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 0) throw new Error("FABENCH_MAX_TOOL_CALLS must be a non-negative integer");
let toolCallsStarted = 0;

if (!corpusPath) throw new Error("FABENCH_CORPUS_DB is required");
if (!asOf) throw new Error("FABENCH_AS_OF is required");

const store = new CorpusStore(corpusPath, "rarity");
const backend = new FrozenBackend(store);

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

function trace(event: Record<string, unknown>): void {
  if (!tracePath) return;
  appendFileSync(
    tracePath,
    `${JSON.stringify({ at_utc: new Date().toISOString(), ...event })}\n`,
  );
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: JsonRpcId, value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id: JsonRpcId, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const started = performance.now();
  if ((name === "web_search" || name === "web_fetch") && toolCallsStarted >= maxToolCalls) {
    trace({ type: "tool_call_skipped", name, args, reason: "research budget exhausted", max_tool_calls: maxToolCalls });
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "research budget exhausted; answer now" }) }],
      isError: true,
    };
  }
  if (name === "web_search" || name === "web_fetch") toolCallsStarted++;
  if (name === "web_search") {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "query is required" }) }],
        isError: true,
      };
    }
    const requested = Number(args.num_results ?? 10) || 10;
    const n = Math.min(Math.max(Math.trunc(requested), 1), maxResults);
    const hits = await backend.search(query, n, asOf);
    const payload = {
      results: hits.map((hit) => ({
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet,
        source: hit.source,
      })),
    };
    trace({
      type: "tool_call",
      name,
      args: { query, num_results: requested },
      effective_num_results: n,
      result_count: hits.length,
      returned_urls: hits.map((hit) => hit.url),
      duration_ms: Math.round(performance.now() - started),
    });
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  }

  if (name === "web_fetch") {
    const url = String(args.url ?? "").trim();
    const doc = url ? await backend.fetch(url, asOf) : null;
    const payload = doc
      ? { title: doc.title, url: doc.url, text: doc.body.replace(/\s+/g, " ") }
      : { error: "could not fetch this URL" };
    trace({
      type: "tool_call",
      name,
      args: { url },
      fetched: Boolean(doc),
      fetched_chars: doc?.body.length ?? 0,
      duration_ms: Math.round(performance.now() - started),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      ...(doc ? {} : { isError: true }),
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ error: `unknown tool ${name}` }) }],
    isError: true,
  };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    void (async () => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        error(null, -32700, "Parse error");
        return;
      }

      const id = request.id ?? null;
      try {
        if (request.method === "initialize") {
          const requestedVersion = String(request.params?.protocolVersion ?? "2025-06-18");
          result(id, {
            protocolVersion: requestedVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "raven-frozen", version: "0.1.0" },
          });
          return;
        }
        if (request.method === "notifications/initialized") return;
        if (request.method === "ping") {
          result(id, {});
          return;
        }
        if (request.method === "tools/list") {
          result(id, {
            tools: [
              {
                name: "web_search",
                description:
                  "Search a news archive. Returns matching articles with title, url and a short snippet. " +
                  `Vary wording as needed; use web_fetch to read decisive articles. Search and fetch share a limit of ${maxToolCalls} calls.`,
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string", description: "Keyword query, roughly 3-8 words." },
                    num_results: {
                      type: "integer",
                      description: "Number of results (default 10, maximum 20).",
                    },
                  },
                  required: ["query"],
                  additionalProperties: false,
                },
              },
              {
                name: "web_fetch",
                description: "Fetch the full text of one article URL returned by web_search.",
                inputSchema: {
                  type: "object",
                  properties: { url: { type: "string" } },
                  required: ["url"],
                  additionalProperties: false,
                },
              },
            ],
          });
          return;
        }
        if (request.method === "tools/call") {
          const name = String(request.params?.name ?? "");
          const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
          result(id, await callTool(name, args));
          return;
        }
        if (request.id !== undefined) error(id, -32601, `Method not found: ${request.method}`);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        trace({ type: "server_error", method: request.method ?? null, message });
        error(id, -32603, message);
      }
    })();
  }
});

function close(): void {
  try {
    store.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
process.stdin.on("end", close);
