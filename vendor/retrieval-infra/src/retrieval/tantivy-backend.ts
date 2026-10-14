import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendDoc, BackendResult, SearchBackend } from "./search-backend.js";
import { querySnippet } from "./snippet.js";
import { RetrievalInfrastructureError } from "./infrastructure-error.js";

/** Each invocation opens an immutable index. No cross-question query state or live calls. */
export class TantivyBackend implements SearchBackend {
  readonly name = "frozen";
  private searches = 0;
  private fetches = 0;
  private searchMs = 0;
  readonly identity: Record<string, unknown>;
  constructor(private readonly index: string, private readonly searchContent: "full" | "excerpt" = "full",
    private readonly python = process.env.FROZEN_PYTHON ?? process.env.HTMLDATE_PYTHON ?? "python3") {
    const bytes = readFileSync(join(index, "manifest.json"));
    const manifest = JSON.parse(bytes.toString());
    if (manifest.policy !== "tantivy-strict-cutoff-bm25-title3-body1-v2") throw new Error("Unsupported frozen snapshot");
    this.identity = { engine: "tantivy", manifest_sha256: createHash("sha256").update(bytes).digest("hex"),
      records_sha256: manifest.records_sha256, anchor_ms: manifest.anchor_ms, policy: manifest.policy,
      tantivy_version: manifest.tantivy_version };
  }
  assertAnchor(asOf: string): void {
    const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf + "T23:59:59.999Z" : asOf);
    if (!Number.isFinite(time) || time !== this.identity.anchor_ms)
      throw new Error("Tantivy snapshot requires this question's exact anchor");
  }
  private request(request: unknown): Promise<{ hits: { title: string; body: string; url: string; crawlDate: string }[]; seconds: number }> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.python, [new URL("../../tools/tantivy_frozen.py", import.meta.url).pathname,
        "query", "--index", this.index], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        if (error) { reject(new RetrievalInfrastructureError("frozen-index", "query_failed", "Tantivy query failed", { cause: error })); return; }
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
      child.stdin!.on("error", (error) => reject(new RetrievalInfrastructureError(
        "frozen-index", "input_failed", "Tantivy input failed", { cause: error },
      )));
      child.stdin!.end(JSON.stringify(request));
    });
  }
  async search(query: string, n: number, asOf: string): Promise<BackendResult[]> {
    this.assertAnchor(asOf);
    this.searches++;
    const response = await this.request({ operation: "search", query, n, as_of: asOf });
    this.searchMs += response.seconds * 1_000;
    return response.hits.map((h) => ({ title: h.title, url: h.url, crawlDate: h.crawlDate, source: "frozen",
      snippet: this.searchContent === "full" ? h.body : querySnippet(h.body, query) }));
  }
  async fetch(url: string, asOf: string): Promise<BackendDoc | null> {
    this.assertAnchor(asOf);
    this.fetches++;
    const response = await this.request({ operation: "fetch", url, as_of: asOf });
    const hit = response.hits[0];
    return hit ? { ...hit, source: "frozen" } : null;
  }
  stats() { return { searches: this.searches, fetches: this.fetches, index_search_ms: this.searchMs }; }
}
