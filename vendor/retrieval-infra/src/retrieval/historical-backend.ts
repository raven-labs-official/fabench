import { DatabaseSync } from "node:sqlite";
import { contentTerms } from "../corpus/store.js";
import { anchorUtc, validateSnapshot, type HistoricalSnapshot, type HistoricalDocument } from "../corpus/historical-snapshot.js";
import type { BackendDoc, BackendResult, SearchBackend } from "./search-backend.js";

/** Small, explicitly seeded pilot corpus. No network or post-anchor ranking statistics. */
export class HistoricalBackend implements SearchBackend {
  readonly name = "historical";
  private readonly db = new DatabaseSync(":memory:");
  private readonly documents = new Map<string, HistoricalDocument>();
  private readonly cutoff: string;
  private searches = 0;
  private fetches = 0;

  constructor(snapshot: HistoricalSnapshot) {
    const checked = validateSnapshot(structuredClone(snapshot));
    this.cutoff = anchorUtc(checked.asOf);
    this.db.exec("CREATE VIRTUAL TABLE evidence USING fts5(title, body, url UNINDEXED, tokenize='unicode61')");
    const insert = this.db.prepare("INSERT INTO evidence(title,body,url) VALUES(?,?,?)");
    for (const doc of checked.documents) {
      this.documents.set(doc.url, doc);
      insert.run(doc.title, doc.body, doc.url);
    }
  }

  assertAnchor(asOf: string) {
    if (anchorUtc(asOf) !== this.cutoff) throw new Error("Historical snapshot anchor must exactly match the question anchor");
  }

  async search(query: string, n: number, asOf: string): Promise<BackendResult[]> {
    this.assertAnchor(asOf); this.searches++;
    const terms = contentTerms(query).slice(0, 32);
    if (!terms.length || !Number.isFinite(n) || n < 1) return [];
    const rows = this.db.prepare("SELECT url FROM evidence WHERE evidence MATCH ? ORDER BY bm25(evidence), url LIMIT ?")
      .all(terms.map(t => `"${t}"`).join(" OR "), Math.min(Math.floor(n), 100));
    return rows.map(row => {
      const d = this.documents.get(String(row.url))!;
      return { title: d.title, url: d.url, snippet: d.body,
        source: "historical", evidence: { ...d.evidence } };
    });
  }

  async fetch(url: string, asOf: string): Promise<BackendDoc | null> {
    this.assertAnchor(asOf); this.fetches++;
    // Only exact immutable URLs returned by search are fetchable; never follow live links.
    const d = this.documents.get(url);
    return d ? { title: d.title, url: d.url, body: d.body, source: "historical", evidence: { ...d.evidence } } : null;
  }
  stats() { return { searches: this.searches, fetches: this.fetches, documents: this.documents.size }; }
  close() { this.db.close(); }
}
