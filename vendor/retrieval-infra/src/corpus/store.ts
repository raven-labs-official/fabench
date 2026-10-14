import { assertSourceOnlyGrewAfterAnchor } from './retrieval-identity.js';
/**
 * Frozen corpus store backed by SQLite FTS5 (Node's built-in `node:sqlite`).
 *
 * This is the Phase-0 search backend (see docs/design/raven-bench/05-corpus-and-lifecycle.md).
 * It holds web documents stamped with a crawl timestamp and answers keyword
 * searches that are filtered to `crawl_ms <= asOf` — true time isolation, because
 * a document's crawl timestamp is when it was physically captured and cannot
 * contain anything written after that instant.
 *
 * For CC-News TB-scale the same RetrievalEnv interface is re-backed by Pyserini;
 * only this class is swapped, not the predictor-facing contract.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createHash } from 'node:crypto';
import { FrozenRouteCache, type FrozenRouteRow } from './frozen-route-cache.js';
import { pathToFileURL } from "node:url";
import { capturedDocumentHash, type FrozenIndexMetadata } from "./frozen-index.js";
import { BodyCodec, decodeBody, installBodyView } from "./body-codec.js";
import { queryIdentity } from "./query-identity.js";
import { planQuery, rankAndDeduplicate, type QueryPlanOptions, type QueryPlan, type QueryAliases, type RankedDocument, type RankFeatureCache } from "./query-plan.js";
import { assertCorpusAvailable } from "../data-guard.js";
import { prepareBrowse, type BrowseOptions, type BrowsePage } from "./browse.js";
import { timedSync } from '../observability/timeline.js';
import { loadCachedBm25 } from './bm25-extension.js';

export interface CorpusDoc {
  url: string;
  title: string;
  body: string;
  /** When the crawler physically captured this page. ISO 8601. */
  crawlDate: string;
  /**
   * Which feed this came from — "ccnews", "gdelt", "wayback", a publisher's own archive.
   *
   * Recorded per document rather than per database so several feeds can share one index and
   * still be told apart afterwards. That matters for the measurement, not just for tidiness:
   * "what did adding this source buy us" is answerable only if the documents it contributed
   * are identifiable after the fact.
   */
  source?: string;
  /**
   * Wire service this document republishes ("AP" / "Reuters" / ...), or null.
   * The wires block Common Crawl in robots.txt, so their own domains are absent —
   * but local outlets and public-radio stations republish them and are crawlable.
   * Tagging at ingest makes that recoverable without re-reading every body later.
   */
  wire?: string | null;
}

export interface SearchHit {
  url: string;
  title: string;
  body: string;
  crawlDate: string;
  /** FTS5 BM25 relevance; lower (more negative) = more relevant. */
  score: number;
}

/**
 * Parse an ISO timestamp to epoch milliseconds.
 * A date-only value (`2025-03-01`) used as an `asOf` cutoff is treated as the
 * end of that day so same-day crawls are included.
 */
function toMs(iso: string, dateOnlyAsEndOfDay = false): number {
  let s = iso.trim();
  if (dateOnlyAsEndOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    s = `${s}T23:59:59.999Z`;
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO date: "${iso}"`);
  }
  return ms;
}

// Common English words carry no retrieval signal but, matched across millions of
// docs, blow up the candidate set (slow) and add noise (imprecise). Drop them and
// dedup so the AND expression stays selective.
const STOPWORDS = new Set(
  ("the a an of to in on for and or is are will would by before after with at as be this that " +
    "it its from was were has have had not no than then which who whom whose what when where how " +
    "why between during into about over under more most less any all each per up down out if do " +
    "does did been being can could may might must should new news say said says year years " +
    "there here their them they he she his her we you your our us i me my one two").split(" "),
);

/**
 * Split a free-text query into content-bearing terms.
 *
 * The tokenizer must be unicode-aware. A plain /[a-z0-9]+/ splits accented names into
 * fragments — "Sánchez" becomes "s" + "nchez", "Türkiye" becomes "t" + "rkiye" — and
 * because those fragments are then ANDed as mandatory terms, the query can return
 * nothing at all. FTS5's unicode61 tokenizer folds diacritics at index time, so the
 * fix belongs on the query side: normalise, strip combining marks, then match letters
 * and numbers by Unicode property.
 *
 * Length rules differ by token type. Two-letter words survive the length rule, which is what
 * keeps "EU" (592k documents) and "UN" (566k) — both genuinely selective. "US" does NOT
 * survive, because it is in STOPWORDS above, and that is deliberate even though it reads
 * like an oversight: `us` occurs in 8,678,010 documents, 44% of the index, since the pronoun
 * and the country share a spelling once case is folded. A term matching nearly half the
 * corpus does not narrow anything. Measured both ways on "US forces enter Iran" and
 * "US government shutdown", adding it returned the same documents in near-identical order.
 * So questions about the United States are found through the rest of their words, and the
 * country name is left out on purpose.
 *
 * Bare numbers must be four digits:
 * a year carries information, but the day in "May 31, 2026" and the "26" in "2025-26"
 * do not, and they are rare enough to displace real terms once terms are ranked by
 * rarity. Admitting short numerals cost 14 points of retrieval recall in a
 * measured A/B, which is how this rule was found.
 */
export function contentTerms(query: string): string[] {
  const folded = query
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase();
  const tokens = (folded.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => {
    if (STOPWORDS.has(t)) return false;
    return /^\d+$/.test(t) ? t.length === 4 : t.length >= 2;
  });
  return [...new Set(tokens)];
}

/**
 * The tokenisation this class shipped with, kept so the change can be A/B'd.
 *
 * Comparing across separate runs does not work here: the decisive facts a run scores
 * against are re-extracted by a model each time, so two runs are two different rulers.
 * The only valid comparison puts both term strategies in ONE run against ONE fact set,
 * which needs both implementations present.
 */
function contentTermsLegacy(query: string): string[] {
  const tokens = (query.toLowerCase().match(/[a-z0-9]+/gi) ?? []).filter(
    (t) => t.length > 2 && !LEGACY_STOPWORDS.has(t),
  );
  return [...new Set(tokens)];
}

const LEGACY_STOPWORDS = new Set(
  ("the a an of to in on for and or is are will would by before after with at as be this that " +
    "it its from was were has have had not no than then which who whom whose what when where how " +
    "why between during into about over under more most less any all each per up down out if do " +
    "does did been being can could may might must should new news say said says year years").split(" "),
);

export type TermStrategy = "rarity" | "legacy" | "or" | "concept";

export class CorpusStore {
  private readonly db: DatabaseSync;
  /** fts5vocab companion, created lazily on first search (see byRarity). */
  private vocabReady = false;
  private frozenAnchor?: string;
  private frequencyStatement?: StatementSync;
  // Only the immutable historical FTS may reuse document frequencies. No bodies
  // or source verification results are cached across requests.
  private frozenFrequencies = new Map<string, number>();
  /** Ranking function for frozen-index routes: bm25_cached() when its extension is loaded. */
  private frozenRank = 'bm25';
  private routeCache?: FrozenRouteCache;
  private indexStamp?: {path:string;size:number;mtimeMs:number;ino:number};
  /** Present when the corpus stores encoded bodies; new rows are encoded with it. */
  private bodyCodec?: BodyCodec;

  /**
   * @param path file path, or ":memory:" for an ephemeral store (tests).
   * @param termStrategy how query terms are chosen — "rarity" (default) ranks by the
   *   index's own document frequency; "legacy" reproduces the original behaviour so
   *   the two can be compared inside a single run.
   * @param mode "auto" (default) opens an existing corpus READ-ONLY and only takes a
   *   writable handle when the file has to be created; "write" forces a writable handle
   *   and is what ingest uses.
   *
   * WHY READ-ONLY MATTERS. A frozen corpus whose whole value is "this file will not
   * change" was being opened read-write on every search, and then issued CREATE TABLE IF
   * NOT EXISTS plus a conditional ALTER TABLE each time. Nothing visibly broke, but three
   * things were quietly true: the file could not live on a read-only volume, several query
   * processes could not share it safely, and any accidental write would invalidate the
   * SHA-256 we intend to publish alongside it. Opening read-only when the database already
   * exists costs nothing — searches behave identically — and makes the freeze real rather
   * than a convention.
   */
  constructor(
    path = ":memory:",
    private readonly termStrategy: TermStrategy = "rarity",
    mode: "auto" | "write" = "auto",
    private readonly queryOptions: QueryPlanOptions & {sharedFrozenCachePath?:string;sharedFrozenCacheSlots?:number;cacheOwner?:string;
      /** Diagnostics only: read bodies from a verified rewrite of the recorded source, such as a
       * compacted copy, before it replaces the original. Experiments never set this. */
      frozenSourcePath?:string} = {},
  ) {
    // A dangling data symlink otherwise surfaces as "unable to open database file".
    if (path !== ":memory:" && mode !== "write" && (!existsSync(path) || statSync(path).isDirectory())) assertCorpusAvailable(path);
    const existing = path !== ":memory:" && existsSync(path);
    const readOnly = mode === "auto" && existing;
    this.db = readOnly ? new DatabaseSync(path, { readOnly: true, allowExtension: true }) : new DatabaseSync(path);
    // Concurrent readers may briefly contend while SQLite initializes WAL shared memory.
    // A zero busy timeout turns this startup lock into a failed worker pool.
    this.db.exec('PRAGMA busy_timeout=10000');
    const isFrozenIndex = existing && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='frozen_index_metadata'").get();
    if (isFrozenIndex) {
      try {
        if (!readOnly) throw new Error('frozen index may only be opened read-only');
        const row=this.db.prepare('SELECT json FROM frozen_index_metadata WHERE id=1').get() as {json:string}|undefined;
        const meta:FrozenIndexMetadata|null=row ? JSON.parse(row.json) : null;
        if (meta?.schema!=='raven.frozen-index.v1' || meta.status!=='complete') throw new Error('frozen index build is incomplete');
        const sourcePath=queryOptions.frozenSourcePath??meta.source.path;
        const st=statSync(sourcePath);
        if(sourcePath!==meta.source.path||st.size!==meta.source.size||st.mtimeMs!==meta.source.mtimeMs)assertSourceOnlyGrewAfterAnchor(meta,st.size,sourcePath);
        const sourceUri=pathToFileURL(sourcePath);sourceUri.search='mode=ro';
        this.db.prepare('ATTACH DATABASE ? AS source_corpus').run(sourceUri.href);
        // A compacted source stores encoded bodies; the hash check below sees the decoded text.
        const sourceCodec=BodyCodec.load(this.db,'source_corpus');
        this.db.function('raven_corpus_body',{deterministic:true},(body)=>decodeBody(body,sourceCodec));
        // Each worker keeps its own bounded hot FTS pages. Source bodies still
        // pass through the verified view on every read.
        this.db.exec('PRAGMA main.cache_size=-65536; PRAGMA source_corpus.cache_size=-16384');
        this.db.function('raven_verified_body',(url,title,body,crawlDate,expected)=>{
          if(typeof url!=='string'||typeof title!=='string'||typeof body!=='string'||typeof crawlDate!=='string'||!(expected instanceof Uint8Array)||!capturedDocumentHash(url,title,body,crawlDate).equals(expected))throw new Error('frozen source document differs from captured bytes');
          return body;
        });
        this.db.exec(`CREATE TEMP VIEW docs AS SELECT d.id,d.url,d.title,
          raven_verified_body(d.url,d.title,raven_corpus_body(d.body),d.crawl_date,f.body_sha256) AS body,
          d.crawl_date,d.crawl_ms,d.wire,d.source
          FROM source_corpus.docs d JOIN main.frozen_documents f ON f.id=d.id`);
        this.frozenAnchor=meta.anchor;
        if(loadCachedBm25(this.db))this.frozenRank='bm25_cached';
        if(queryOptions.sharedFrozenCachePath) {
          const canonical=realpathSync(path),st=statSync(canonical);
          this.indexStamp={path:canonical,size:st.size,mtimeMs:st.mtimeMs,ino:st.ino};
          const sqlite=this.db.prepare('SELECT sqlite_version() AS version').get()!.version;
          const identity=createHash('sha256').update(JSON.stringify([this.indexStamp,row!.json,sqlite])).digest('hex');
          this.routeCache=new FrozenRouteCache(queryOptions.sharedFrozenCachePath,identity,
            {workers:queryOptions.sharedFrozenCacheSlots??4,maxBytes:64*1024*1024,maxEntries:10000},queryOptions.cacheOwner);
        }
      } catch(error) {this.db.close();throw error;}
      return;
    }
    if (readOnly) this.db.enableLoadExtension(false); // only a frozen index may load bm25_cached()
    if(queryOptions.sharedFrozenCachePath) {this.db.close();throw new Error('Shared frozen query cache requires a complete immutable historical index');}
    if (readOnly) {
      try { assertCorpusAvailable(path); this.installBodyView(); } catch(error) { this.db.close();throw error; }
      return; // ordinary corpus schema already exists; a recognized compact index was handled above
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id        INTEGER PRIMARY KEY,
        url       TEXT NOT NULL,
        title     TEXT NOT NULL,
        body      TEXT NOT NULL,
        crawl_date TEXT NOT NULL,
        crawl_ms  INTEGER NOT NULL,
        wire      TEXT,
        source    TEXT NOT NULL DEFAULT 'ccnews'
      );
      CREATE INDEX IF NOT EXISTS idx_docs_crawl_ms ON docs(crawl_ms);
      CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(source);
      CREATE INDEX IF NOT EXISTS idx_docs_url ON docs(url);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        title, body, content='docs', content_rowid='id'
      );
      -- Document-frequency view over the FTS index, used to rank query terms by rarity.
      -- Create it here rather than lazily on first search: a freshly built corpus is then
      -- complete, and searching it read-only works. A corpus built without this line raises
      -- "docs_vocab is missing and cannot be created" on the first read-only search — a
      -- failure that only shows up on a machine other than the one that built the corpus.
      -- It is a virtual table over data that already exists, so creating it is instant.
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_vocab USING fts5vocab(docs_fts, 'row');
    `);
    // Databases built before a column exists must keep working. The 143 GiB index took days
    // to build; a schema change that required rebuilding it would not get made.
    const cols = (this.db.prepare(`PRAGMA table_info(docs)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("wire")) this.db.exec(`ALTER TABLE docs ADD COLUMN wire TEXT`);
    if (!cols.includes("source")) {
      // Existing rows are CC-NEWS by definition — it was the only source before this column.
      this.db.exec(`ALTER TABLE docs ADD COLUMN source TEXT NOT NULL DEFAULT 'ccnews'`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(source)`);
    }
    this.installBodyView();
  }

  /** A compacted corpus stores bodies as encoded blobs. Readers see the original text through
   * a connection-local view that shadows main.docs; writes name main.docs explicitly. */
  private installBodyView() {
    this.bodyCodec=installBodyView(this.db)??undefined;
  }

  /** Insert documents. Returns the number ingested. Runs in one transaction. */
  ingest(docs: Iterable<CorpusDoc>): number {
    const insDoc = this.db.prepare(
      `INSERT INTO main.docs (url, title, body, crawl_date, crawl_ms, wire, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insFts = this.db.prepare(
      `INSERT INTO docs_fts (rowid, title, body) VALUES (?, ?, ?)`,
    );
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const d of docs) {
        const { lastInsertRowid } = insDoc.run(
          d.url,
          d.title,
          this.bodyCodec ? this.bodyCodec.encode(d.body) : d.body,
          d.crawlDate,
          toMs(d.crawlDate),
          d.wire ?? null,
          d.source ?? "ccnews",
        );
        insFts.run(lastInsertRowid, d.title, d.body);
        n++;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return n;
  }

  /**
   * BM25 keyword search, hard-filtered to documents crawled at or before `asOf`.
   * Returns up to `limit` hits, most relevant first.
   */
  /**
   * Order terms rarest-first using the index's own document frequencies.
   *
   * Taking terms in the order they happen to appear in the question is the single
   * worst thing this class did. "Will Chelsea win the 2025-26 English Premier
   * League?" compiled to `chelsea AND win AND 2025 AND english` — three near-useless
   * terms crowding out "premier league" — and two different Fed questions compiled to
   * byte-identical expressions. Ranking by document frequency puts the terms that
   * actually narrow the corpus first, which is what the AND relaxation below assumes.
   *
   * fts5vocab exposes per-term document counts directly off the existing index, so
   * this costs one small lookup and no extra storage. Terms absent from the vocab get
   * df 0 and sort first. They remain mandatory during AND relaxation; removing an
   * unknown identifier can turn an honest coverage miss into unrelated results.
   */
  private byRarity(terms: string[]): string[] {
    if (!this.vocabReady) {
      // Creating the vocab table needs a write lock, which a read-only handle does not have.
      // Silently returning the caller's term order instead would be the worst outcome
      // available: that is exactly the pre-fix behaviour this ranking replaced, it costs
      // real recall, and nothing in the output would show it had happened. So a missing
      // vocab table on a read-only corpus is raised, not absorbed.
      const present = (
        this.db
          .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'docs_vocab'`)
          .get() as { n: number }
      ).n > 0;
      if (present) {
        this.vocabReady = true;
      } else {
        try {
          this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs_vocab USING fts5vocab(docs_fts, 'row')`);
          this.vocabReady = true;
        } catch (e) {
          throw new Error(
            `docs_vocab is missing and cannot be created (corpus opened read-only). ` +
              `Rebuild it once with a writable handle, or term ranking silently degrades: ${(e as Error).message}`,
          );
        }
      }
    }
    const df = this.db.prepare(`SELECT doc AS n FROM docs_vocab WHERE term = ?`);
    const scored = terms.map((t) => {
      const row = df.get(t) as { n: number } | undefined;
      return { t, n: row?.n ?? 0 };
    });
    return scored.sort((a, b) => a.n - b.n).map((x) => x.t);
  }

  /**
   * Title reduced to what identifies the STORY, so reprints of one wire file collapse.
   *
   * Publishers append their own name after a dash or pipe — "… – 95.5 WSB", "… | Outlook
   * India" — and otherwise leave the headline alone, so stripping that suffix and
   * normalising punctuation is enough. Deliberately conservative: two genuinely different
   * stories almost never share a headline, while a wire file shares it across dozens of
   * sites.
   */
  private static normaliseTitleImpl(title: string): string {
    return title
      .replace(/\s*[|\u2013\u2014-]\s*[^|\u2013\u2014-]{0,40}$/u, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  /**
   * How strongly to prefer documents close to the anchor, in the same units as the BM25 score.
   *
   * A search engine asked a news question at time T does not treat a story from six months
   * earlier the same as one from yesterday; BM25 alone does exactly that, and it is the
   * largest behavioural gap between this index and what a searcher would have seen. The fix
   * costs nothing and leaks nothing: recency is measured against the anchor using the crawl
   * timestamp already stored on every row, so no signal from after the anchor is involved.
   *
   * Applied as `score + weight * exp(-ageDays / halfLifeDays)`. FTS5's `rank` is negative and
   * smaller is better, so the bonus is SUBTRACTED from it; a document one half-life older
   * than another loses about `weight * 0.63` of an ordering unit.
   *
   * Off by default at 0. It changes which documents a run sees, so it is a measured knob
   * rather than a silent default — turn it on, measure, and record the value with the result.
   */
  recencyWeight = 0;
  recencyHalfLifeDays = 30;

  /**
   * Run a hand-written FTS5 expression, with the anchor gate and nothing else.
   *
   * `search` rewrites the query — stopwords out, rarest terms picked, AND-levels relaxed — which
   * is right for the experiment and wrong for asking whether the corpus CONTAINS something. A
   * membership check needs the exact conjunction it asked for: `"Centenaro" AND "Selvazzano"`
   * returning nothing means those two words never co-occur before the anchor, whereas the same
   * question through the rewriter could return documents about neither.
   *
   * Ordering is by rank as elsewhere; the caller wanting existence rather than ranking should
   * read `limit = 1`.
   */
  /** Top rows of one frozen route. bm25_cached() and bm25() return the same rows and scores. */
  private get frozenRouteSql(){
    return this.frozenRank==='bm25_cached'
      ? "SELECT rowid,rank FROM docs_fts WHERE docs_fts MATCH ? AND rank MATCH 'bm25_cached()' ORDER BY rank LIMIT ?"
      : 'SELECT rowid,rank FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?';
  }
  /** Which ranking function frozen routes use; diagnostics only. */
  get frozenRankFunction(){return this.frozenRank;}
  searchRaw(ftsExpression: string, asOf: string, limit = 10): SearchHit[] {
    this.requireFrozenAnchor(asOf);
    if(this.frozenAnchor){
      if(this.routeCache) {
        const st=statSync(this.indexStamp!.path),stamp=this.indexStamp!;
        if(st.size!==stamp.size || st.mtimeMs!==stamp.mtimeMs || st.ino!==stamp.ino)
          throw new Error('Frozen index changed while its query cache was active');
        const ids=this.routeCache.getOrCompute(ftsExpression,limit,()=>this.db.prepare(
          this.frozenRouteSql
        ).all(ftsExpression,limit) as FrozenRouteRow[]);
        // Preserve every candidate and its FTS order; source bodies are verified on
        // every cache hit, including candidates discarded by the final reranker.
        const rows=timedSync('frozen.route.hydrate',()=>this.db.prepare(`SELECT d.url,d.title,d.body,
          d.crawl_date AS crawlDate,json_extract(t.value,'$.rank') AS score FROM json_each(?) t
          JOIN docs d ON d.id=json_extract(t.value,'$.rowid') ORDER BY score,CAST(t.key AS INTEGER)`
        ).all(JSON.stringify(ids)));
        if(rows.length!==ids.length) throw new Error('Cached frozen candidate no longer exists in the captured source');
        return rows.map(r=>({...r,wire:null,source:null})) as unknown as SearchHit[];
      }
      // The completed index already contains only this exact anchor's documents.
      // Select its top IDs before joining source rows; the docs view still verifies
      // every returned body against its captured hash. Do not use this on a live corpus.
      const rows=this.db.prepare(`WITH top_hits AS MATERIALIZED (
        ${this.frozenRouteSql}
      ) SELECT d.url,d.title,d.body,d.crawl_date AS crawlDate,t.rank AS score
        FROM top_hits t JOIN docs d ON d.id=t.rowid ORDER BY t.rank`).all(ftsExpression,limit);
      return rows.map(r=>({...r,wire:null,source:null})) as unknown as SearchHit[];
    }
    const rows = this.db
      .prepare(
        `SELECT d.url, d.title, d.body, d.crawl_date AS crawlDate, docs_fts.rank AS score
           FROM docs_fts
           JOIN docs d ON d.id = docs_fts.rowid
          WHERE docs_fts MATCH ? AND d.crawl_ms <= ?
          ORDER BY docs_fts.rank
          LIMIT ?`,
      )
      .all(ftsExpression, toMs(asOf, true), limit) as Array<{
      url: string; title: string; body: string; crawlDate: string; score: number;
    }>;
    return rows.map((r) => ({ ...r, wire: null, source: null })) as unknown as SearchHit[];
  }

  /** Reuse scores only when every freshly verified candidate and every plan field
   * is identical. The cache stores positions/scores, never a replacement body.
   */
  rankVerified(rows:RankedDocument[],plan:QueryPlan,limit:number,features?:RankFeatureCache):RankedDocument[] {
    if(!this.routeCache) return rankAndDeduplicate(rows,plan,limit,features);
    const digest=createHash('sha256').update(JSON.stringify(['rank-exact-input-v1',plan,limit]));
    for(const row of rows) digest.update(JSON.stringify({...row,body:createHash('sha256').update(row.body).digest('hex')}));
    const selected=this.routeCache.getOrCompute(digest.digest('hex'),limit,()=>
      rankAndDeduplicate(rows,plan,limit,features).map(doc=>({rowid:rows.findIndex(r=>
        r.url===doc.url && r.title===doc.title && r.body===doc.body && r.crawlDate===doc.crawlDate)+1,rank:doc.score})), 'rank');
    return selected.map(({rowid,rank})=>{
      if(!rows[rowid-1]) throw new Error('Cached ranking references an absent verified candidate');
      return {...rows[rowid-1]!,score:rank};
    });
  }

  search(query: string, asOf: string, limit = 10): SearchHit[] {
    this.requireFrozenAnchor(asOf);
    if (this.termStrategy === "concept") return this.searchPlanned(query, asOf, limit).hits;
    const identity = this.termStrategy === "rarity" ? queryIdentity(query) : { remaining: query, constraints: [] };
    const terms =
      this.termStrategy === "legacy"
        ? contentTermsLegacy(query)
        : this.byRarity(contentTerms(identity.remaining));
    if (terms.length === 0 && identity.constraints.length === 0) return [];
    const asOfMs = toMs(asOf, true);
    // ORDER BY rank, never ORDER BY bm25(docs_fts). They return the same ordering,
    // but only `rank` lets FTS5 push the top-k down into the index; the function call
    // forces every match to be scored and sorted first. Measured on the 19.8M-doc
    // index, one query over 1.5M matches: 452,354 ms with bm25(), 5,636 ms with rank.
    // ORDER BY rank, never ORDER BY bm25(docs_fts) — see the note above. With a recency
    // bonus the ordering expression has to be materialised, so the top-k pushdown is lost and
    // the candidate set is bounded explicitly instead: rank the cheap way first, then reorder
    // that window. Reordering a window is not the same as reordering everything, and a
    // document outside the window cannot be recovered by any weight — which is why the window
    // is generous relative to `limit`.
    const stmt =
      this.recencyWeight > 0
        ? this.db.prepare(
            `SELECT url, title, body, crawlDate, score FROM (
               SELECT d.url, d.title, d.body, d.crawl_date AS crawlDate,
                      docs_fts.rank AS score, d.crawl_ms AS ms
                 FROM docs_fts
                 JOIN docs d ON d.id = docs_fts.rowid
                WHERE docs_fts MATCH ? AND d.crawl_ms <= ?
                ORDER BY docs_fts.rank
                LIMIT ?
             )
             ORDER BY score - ? * exp(-((? - ms) / 86400000.0) / ?)`,
          )
        : this.db.prepare(
            `SELECT d.url, d.title, d.body, d.crawl_date AS crawlDate, docs_fts.rank AS score
               FROM docs_fts
               JOIN docs d ON d.id = docs_fts.rowid
              WHERE docs_fts MATCH ? AND d.crawl_ms <= ?
              ORDER BY docs_fts.rank
              LIMIT ?`,
          );
    const RECENCY_WINDOW = 400;
    const runStmt = (expr: string, cap: number): SearchHit[] =>
      (this.recencyWeight > 0
        ? stmt.all(expr, asOfMs, Math.max(cap, RECENCY_WINDOW), this.recencyWeight, asOfMs, this.recencyHalfLifeDays)
        : stmt.all(expr, asOfMs, cap)) as unknown as SearchHit[];
    // The honest query: every term OR-ed, BM25 alone deciding what matters.
    //
    // This is what the AND ladder below is an approximation of. A term the article
    // happens not to use costs it nothing here, because OR never excludes — rare terms
    // simply carry more weight than common ones, which is what BM25 is for. It exists
    // to answer one question: how much recall does the AND compromise actually cost?
    //
    // The reason it is not the default is throughput, not relevance. Measured on this
    // index, `kharg OR marines OR traveling OR singapore` matches 528,175 documents and
    // Both strategies below feed rows through the same two filters, so it lives here once:
    // editing the reprint rule in one copy and not the other is the failure this prevents.
    const seenUrl = new Set<string>();
    const seenTitle = new Set<string>();
    const out: SearchHit[] = [];
    /** Append rows for one FTS expression, dropping repeat URLs and syndicated reprints. */
    const collect = (expr: string): void => {
      for (const row of runStmt(expr, limit * 4)) {
        if (seenUrl.has(row.url)) continue;
        seenUrl.add(row.url);
        const key = CorpusStore.normaliseTitleImpl(row.title);
        if (key.length > 12 && seenTitle.has(key)) continue;
        seenTitle.add(key);
        out.push(row);
        if (out.length >= limit) break;
      }
    };

    // FTS5 has no way to skip any of them — no block-max index, so every posting is
    // scored before the top-k falls out. Three sampled queries ran 1.4s / 1.9s / 8.3s
    // against 0.06s for the equivalent AND. At ~50k retrievals per full run that is a
    // day of wall-clock, which is why the ladder was written this way in the first
    // place. On a 40-question audit it costs about seven minutes, so the comparison is
    // cheap to make even though the mode is too slow to adopt as-is.
    if (this.termStrategy === "or") {
      // Cap the term count: past ~12 the additions are common words contributing almost
      // no IDF while multiplying the postings to score.
      const expr = terms.slice(0, 12).map((t) => `"${t}"`).join(" OR ");
      collect(expr);
      return out;
    }
    // Progressive AND relaxation, UNIONED rather than short-circuited.
    //
    // The obvious version — try 4 terms, fall back to 3 only if 4 matched nothing —
    // is wrong, and wrong in a way that is invisible because it always returns
    // something. Every extra ANDed term must appear in the target article, and a
    // near-miss word is enough to exclude it: "5,000 Marines traveling from Singapore
    // toward Kharg Island" selects kharg+marines+traveling+singapore, which matches a
    // handful of generic war round-ups, so the search stops there — while
    // kharg+marines alone matches 1,062 documents including the one headlined "US Navy
    // warship carrying additional Marines to Gulf tracked off Singapore", which says
    // "tracked", not "traveling". A non-empty page of bad results silently suppressed
    // the good ones. Measured across four hand-checked claims, three were in the corpus
    // and the short-circuiting version found one.
    //
    // So collect every level and merge, most selective first. The narrow intersections
    // keep their rank advantage; the broad ones fill the tail instead of being skipped.
    // Cost is bounded: each level is still an AND, so each stays as fast as its rarest
    // term, and there are at most three of them.
    //
    // No OR fallback here — see the "or" strategy above for what that costs and why it
    // is opt-in. If even the two rarest terms never co-occur this returns nothing, which
    // is an honest "no evidence here" at this budget.
    // Syndication means one story occupies a whole result page. The AP file "What to
    // know as war with Iran enters 3rd week" is carried verbatim by the Cox local-TV
    // cluster, and a search for Marines near Kharg Island returned four copies of it in
    // the top four — four slots, one article's worth of information. Collapsing on a
    // normalised title is enough to catch it: reprints keep the headline and change only
    // the trailing station name, which the suffix strip below removes.
    let lastExpr = "";
    for (const k of [4, 3, 2]) {
      if (out.length >= limit) break;
      const expr = [...identity.constraints, ...terms.slice(0, k).map((t) => `"${t}"`)].join(" AND ");
      if (expr === lastExpr) continue; // fewer terms than k → same expr, skip re-run
      lastExpr = expr;
      // Over-fetch, because dedup throws rows away and a page of reprints would
      // otherwise leave the caller short of the k it asked for.
      collect(expr);
    }
    return out;
  }

  /** Frequencies are read only from this anchor's FTS, including for joint-source planning. */
  termFrequency(term: string, asOf: string): number {
    this.requireFrozenAnchor(asOf);
    const cached=this.frozenAnchor?this.frozenFrequencies.get(term):undefined;
    if(cached!==undefined)return cached;
    if(!this.frequencyStatement){this.byRarity([]);this.frequencyStatement=this.db.prepare('SELECT doc AS n FROM docs_vocab WHERE term = ?');}
    const frequency=(this.frequencyStatement.get(term) as {n:number}|undefined)?.n ?? 0;
    if(this.frozenAnchor){
      if(this.frozenFrequencies.size>=200_000)this.frozenFrequencies.delete(this.frozenFrequencies.keys().next().value!);
      this.frozenFrequencies.set(term,frequency);
    }
    return frequency;
  }
  plan(query: string, asOf: string, extraFrequency: (term:string)=>number = () => 0, aliases: QueryAliases[] = []): QueryPlan {
    this.requireFrozenAnchor(asOf);
    return planQuery(query, term => this.termFrequency(term,asOf)+extraFrequency(term),
      {...this.queryOptions, aliases:[...(this.queryOptions.aliases??[]),...aliases]});
  }

  /** Diagnostic provenance is returned to the caller, never substituted for an existence query. */
  searchPlanned(query: string, asOf: string, limit = 10): { hits: SearchHit[]; plan: QueryPlan; routes: { expression: string; candidates: number }[] } {
    this.requireFrozenAnchor(asOf);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1–100');
    const plan = this.plan(query, asOf);
    const rows: SearchHit[] = [], routes = [];
    for (const expression of plan.expressions) {
      const hits = this.searchRaw(expression, asOf, plan.perRoute);
      rows.push(...hits); routes.push({ expression, candidates: hits.length });
    }
    return { hits: rankAndDeduplicate(rows, plan, limit), plan, routes };
  }

  /**
   * Exhaustive, paginated entity membership within capture dates. Unlike search,
   * this does not drop entity words, rank by BM25, or stop at a candidate budget.
   * It preserves each captured version so a later short copy cannot hide an older
   * complete transcript. Callers continue with nextCursor to inspect later pages.
   */
  browse(options: BrowseOptions, asOf: string): BrowsePage {
    this.requireFrozenAnchor(asOf);
    const plan = prepareBrowse(options, asOf);
    // In a frozen store main.docs_fts contains only the historical partition;
    // source_corpus.docs_fts must never participate in candidate membership.
    // The source date index covers both crawl_ms and the rowid. Intersect its
    // date-ordered IDs with historical FTS membership before fetching documents.
    // Joining FTS directly to docs would visit large source rows merely to read
    // their timestamps, even when the requested page contains very few rows.
    // Bodies and frozen hash checks are still evaluated for every returned row.
    const captureTable = this.frozenAnchor ? 'source_corpus.docs' : 'main.docs';
    // A date-first scan is wasteful for a missing/rare entity: it could inspect the
    // entire date index to discover that fewer than one page exists. Probe a bounded
    // prefix, then use rowid lookups when the complete match set has at most 256 IDs.
    // This selects a physical access path only; both branches return the same page.
    const prefix = timedSync('frozen.browse.membership', () => this.db.prepare(
      'SELECT rowid AS id FROM main.docs_fts WHERE docs_fts MATCH ? LIMIT 257',
    ).all(plan.expression)) as {id:number}[];
    const small = prefix.length <= 256;
    const candidates = prefix.length === 0 ? [] : timedSync(
      small ? 'frozen.browse.rowid-selection' : 'frozen.browse.date-selection', () => this.db.prepare(`
      SELECT d.id, d.crawl_ms AS ms
        FROM ${captureTable} d ${small ? 'NOT INDEXED' : 'INDEXED BY idx_docs_crawl_ms'}
       WHERE d.crawl_ms >= ? AND d.crawl_ms <= ?
         AND d.id IN (${small ? prefix.map(() => '?').join(',') : 'SELECT rowid FROM main.docs_fts WHERE docs_fts MATCH ?'})
         ${plan.position ? 'AND (d.crawl_ms < ? OR (d.crawl_ms = ? AND d.id < ?))' : ''}
       ORDER BY d.crawl_ms DESC, d.id DESC
       LIMIT ?
    `).all(plan.lowerMs, Math.min(plan.upperMs, plan.position?.ms ?? plan.upperMs),
      ...(small ? prefix.map(row => row.id) : [plan.expression]),
      ...(plan.position ? [plan.position.ms, plan.position.ms, plan.position.id] : []),
      plan.limit + 1)) as { id: number; ms: number }[];
    const get = this.db.prepare(`SELECT id AS capturedId, url, title, body,
      crawl_date AS crawlDate, 0 AS score FROM docs WHERE id = ?`);
    const page = candidates.slice(0, plan.limit);
    const results = timedSync('frozen.browse.body', () => page.map(({ id }) => get.get(id) as unknown as BrowsePage['results'][number]));
    const last = page.at(-1);
    return {
      results,
      nextCursor: candidates.length > plan.limit && last ? plan.cursorFor(last) : null,
      query: plan.query,
    };
  }

  /**
   * One document by URL, as it existed at or before `asOf`, or null.
   *
   * Backs `web_fetch`. Use the latest capture that is physically before the anchor.
   * Older revisions can omit information that was already available at the anchor;
   * the SQL cutoff protects against later revisions.
   */
  getByUrlBefore(url: string, asOf: string): { url: string; title: string; body: string; crawlDate: string } | null {
    this.requireFrozenAnchor(asOf);
    const row = this.db
      .prepare(
        `SELECT url, title, body, crawl_date AS crawlDate
           FROM docs
          WHERE url = ? AND crawl_ms <= ?
          ORDER BY crawl_ms DESC, id DESC
          LIMIT 1`,
      )
      .get(url, toMs(asOf, true)) as { url: string; title: string; body: string; crawlDate: string } | undefined;
    return row ?? null;
  }

  /**
   * Earliest crawl timestamp at which `url` exists in the corpus on or before `asOf`,
   * or null if the corpus never captured that URL by then. Used to validate citations.
   */
  earliestCrawlBefore(url: string, asOf: string): string | null {
    this.requireFrozenAnchor(asOf);
    const asOfMs = toMs(asOf, true);
    const row = this.db
      .prepare(
        `SELECT crawl_date AS crawlDate
           FROM docs
          WHERE url = ? AND crawl_ms <= ?
          ORDER BY crawl_ms ASC
          LIMIT 1`,
      )
      .get(url, asOfMs) as { crawlDate: string } | undefined;
    return row?.crawlDate ?? null;
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM docs`).get() as { n: number };
    return row.n;
  }

  /** Per-feed counts and date ranges, so "what did adding this source buy us" is answerable. */
  sourceStats(): { source: string; docs: number; earliest: string; latest: string }[] {
    return this.db
      .prepare(
        `SELECT source, count(*) AS docs, min(crawl_date) AS earliest, max(crawl_date) AS latest
           FROM docs GROUP BY source ORDER BY docs DESC`,
      )
      .all() as { source: string; docs: number; earliest: string; latest: string }[];
  }

  private requireFrozenAnchor(asOf: string): void {
    if(this.frozenAnchor && Date.parse(asOf)!==Date.parse(this.frozenAnchor))
      throw new Error('frozen index requires its exact capture anchor; build a separate index for another timestamp');
  }

  close(): void {
    this.routeCache?.close();
    this.db.close();
  }
}
