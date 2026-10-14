import {withTiming,timed,timedSync} from '../../vendor/retrieval-infra/src/observability/timeline.js';
/**
 * AgenticSearchPredictor — the model searches for itself, the way it would on the open web.
 *
 * WHY THIS EXISTS. Every earlier arm handed the model a fixed packet of documents assembled
 * by code: one query, eight documents, no second look. That is not how forecasting works and
 * it is not how these models are built to work. Forecasting is modelling the question,
 * gathering evidence, reasoning, and going back for more — an iteration the old interface had
 * no way to express. Worse, it made the score depend almost entirely on a query string the
 * model never saw: the mechanical query was the question text pasted verbatim, and letting
 * the model write its own queries instead was the single largest measured effect in the run
 * that compared them.
 *
 * WHAT IT OFFERS. Two tools shaped like the ones a model already knows:
 *
 *     web_search(query, num_results)  → [{ title, url, snippet }]
 *     web_fetch(url)                  → full article text
 *
 * Search returns titles and snippets only; the body costs a second call. That split is
 * deliberate — it matches the real tools, and it makes "what did the model choose to read"
 * an observable rather than something the harness decided.
 *
 * TIME ISOLATION is enforced in the store, not in the prompt. Both tools filter on
 * `crawl_ms <= anchor`, the physical time the crawler fetched the page, which — unlike any
 * self-reported publication date — cannot be edited after the fact. There is no instruction
 * the model could follow or ignore; documents from after the anchor are not reachable.
 *
 * WHAT A MISSING URL DOES. `web_fetch` on something outside the corpus returns an error, the
 * same as a dead link on the real web, and says nothing about why. Explaining that the URL is
 * "not in our index" would tell the model it is inside a benchmark; a plain failure is both
 * more realistic and more informative, because the rate of such failures is a measurement of
 * how holey the corpus is.
 *
 * ARCHIVING. Every call and every result is recorded on the transcript. Without it the arm is
 * unreproducible: two runs of the same question issue different searches, and a score with no
 * record of what was searched cannot be audited or explained.
 */
import type { Question, Prediction } from "../types.js";
import type { Predictor, RetrievalEnv, BudgetTier } from "./types.js";
import type { LlmClient, LlmMessage, ToolSpec } from "../llm/benchmark-client.js";
import { parseProbability } from "./parse-probability.js";
import { FORECAST_PARSE_POLICY, parseForecastAnswer, type ForecastResponse } from "./forecast-response.js";
import {
  LEDGER_INSTRUCTIONS,
  computeProbability,
  parseLedger,
  type LedgerComputation,
} from "./evidence-ledger.js";
import { isNonRetryableProviderApiError } from "../llm/openai-compatible.js";
import type {
  RetrievalAuditTrace,
  SearchBackend,
  BackendResult,
  SearchFunnelTrace,
} from "../retrieval/search-backend.js";
import { isRetrievalInfrastructureError } from "../retrieval/infrastructure-error.js";
import { isRetrievalInputError } from "../retrieval/input-error.js";
import { performance } from "node:perf_hooks";
import {
  serializeError,
  sha256,
  sha256Json,
  type AgentTraceSink,
} from "../tracing/trace-archive.js";
import { DEFAULT_MAX_TOOL_CALLS } from "./tool-budget.js";
import {PAGED_TOOL_POLICY, ToolContentPages, ToolContentStorageError, type ToolDelivery} from './tool-content-pages.js';
import {FROZEN_LEAD_POLICY, frozenLead, type FrozenSearchDelivery} from './frozen-search-preview.js';
import { capConversation } from "./context-cap.js";
export { DEFAULT_MAX_TOOL_CALLS };

/**
 * Told to the model before it starts searching, when `describeEnvironment` is on.
 *
 * The idea is the coauthor's: a searcher who knows what is in the archive writes better
 * queries than one guessing at it. Two observed failures point the same way. A model asked
 * about Iran in March 2026 searched "Biden administration Iran policy 2026" — it did not know
 * how far forward the archive reached, so it queried a world that had moved on. And every
 * arm so far has been given eight documents with no idea whether that was the whole corpus or
 * a sliver of it, which makes "search again with different words" hard to reach for.
 *
 * Stated as capability and coverage only. It must never mention a source, an outlet or a
 * topic that bears on any particular question, or the description itself becomes a hint.
 */
const ENVIRONMENT_BRIEF = [
  `About the archive you are searching:`,
  `- It holds roughly 19.7 million English news articles collected from the open web.`,
  `- Coverage runs from September 2025 up to the as-of date of this question. Nothing after`,
  `  the as-of date exists in it, so searching for later events returns nothing.`,
  `- It is a broad crawl, not a curated set: national outlets, regional papers, trade press`,
  `  and aggregators are all present, and one story is often carried by many sites.`,
  `- Search is keyword-based. It matches words, not meaning, so a paraphrase of a headline`,
  `  may miss entirely. Vary the wording and try the specific names, places, numbers and`,
  `  institutions involved rather than a description of the event.`,
  `- Results are ranked by how rare your words are across the archive. Common words add`,
  `  little; distinctive names add a lot.`,
  `- Reporting that ANNOUNCES A FUTURE EVENT (a scheduled meeting, a deadline, a planned`,
  `  vote) ranks lower than reporting about events that already happened, so search for`,
  `  scheduled things explicitly if they matter.`,
].join("\n");

export interface AgenticOptions {
  /**
   * Tell the model what the archive contains and how its search behaves before it starts.
   * Off by default so the effect can be measured as its own arm rather than assumed.
   */
  describeEnvironment?: boolean;
  /**
   * Hard cap on tool calls per question. Defaults to `DEFAULT_MAX_TOOL_CALLS`.
   *
   * Cost and wall-clock scale with it, and so may the score — how much is itself worth
   * measuring, so this is a parameter rather than a constant. The cap is enforced by
   * telling the model it must answer now, not by cutting the conversation off: a truncated
   * conversation yields no probability at all, which the caller would have to default to
   * 0.5 and thereby silently corrupt the results table.
   */
  maxToolCalls?: number;
  /** Upper bound on results per search call, whatever the model asks for. */
  maxResultsPerSearch?: number;
  /**
   * Characters of article text returned by web_fetch. 0 means the whole article.
   *
   * Defaults to whole. A "fetch the full text" tool that silently returns a prefix is
   * lying to the model about what it read: measured over 2,000 sampled articles the corpus
   * runs to a median of 3,528 characters and a 90th percentile of 8,182, so the previous
   * 4,000-character cap truncated 43% of articles and discarded 32% of all body text. The
   * model cannot tell a short article from a truncated one, so it cannot compensate — it
   * reasons from a fragment believing it has the piece. Cost is not the reason to cap this
   * either: the tool loop resends the conversation each turn, which is exactly the shape
   * DeepSeek's prompt cache rewards at 1/120th the price.
   */
  fetchChars?: number;
  /** Explicit delivery treatment. The formal runner defaults to paged. */
  toolDelivery?: ToolDelivery;
  /** Leading original text for plain frozen search; no summary model. */
  frozenSearchDelivery?: FrozenSearchDelivery;
  /**
   * Provider input ceiling for this model, in tokens. 0 or omitted means no cap (the default).
   *
   * Set it and the oldest tool results are replaced by a visible notice until the request fits;
   * see `context-cap.ts` for what is and is not given up, and for the measured failures that
   * motivate it. The limits are per model and an order of magnitude apart, so this is a run
   * setting rather than a constant: qwen3.6-35b-a3b refuses above 229,376, kimi k3 and deepseek
   * above 1,048,576.
   *
   * Turning it on changes what the model reads, so capped runs form their own segment and get
   * their own condition_id.
   */
  maxInputTokens?: number;
  /** Reasoning budget passed through to the model. */
  effort?: string;
  /**
   * Structured evidence ledger ("vNext"): the model classifies evidence and states a base
   * rate, and the probability is computed from them by `evidence-ledger.ts` rather than
   * reported by the model.
   *
   * Off by default. The v1 prompt and its `*0.37*` contract are left byte-identical when this
   * is off, because the A/B's baseline is the runs already in the shared registry — changing
   * the control arm to tidy the code would silently invalidate every comparison against them.
   */
  ledger?: boolean;
  /**
   * Evidence handed to the model instead of letting it search: the ORACLE arm.
   *
   * It answers the one question a retrieval experiment cannot answer from its own results. When
   * a model with search does no better than closed-book, that is consistent with two opposite
   * stories — the evidence was never reachable, or it was reached and misused — and the
   * transcript cannot tell them apart. Giving the model the evidence a hindsight analysis says
   * it needed separates them: if the forecast improves, retrieval was the constraint; if it does
   * not, the constraint is what the model does with evidence.
   *
   * The packet is assembled from the known outcome, so this arm measures a CEILING and is not a
   * system anyone could deploy. That is the point of a ceiling: it bounds what better retrieval
   * could ever be worth.
   */
  providedEvidence?: string;
  /** Durable event sink. When supplied, every model attempt/message/tool result is recorded. */
  trace?: AgentTraceSink;
}

/**
 * Adapted from the live trading system's `probability-analysis` skill and the seven-stage
 * pulse flow it drives (services/orchestrator/src/pulse/stage-flow.ts). That framework has
 * been run against real money on Polymarket, which is a harder test than any prompt written
 * for this benchmark had passed.
 *
 * WHAT WAS TAKEN, and why each piece earns its place here:
 *   - Pin the resolution boundary FIRST, including the traps. The live skill is explicit
 *     that a unilateral statement is not a bilateral agreement and that "talks are ongoing"
 *     is not "a settleable deal has been reached". That exact distinction is what a measured
 *     failure turned on: given reporting that a ceasefire already ran past the deadline, the
 *     model concluded no fresh announcement was needed and answered 0.09 against an outcome
 *     of yes.
 *   - Decompose into 2-5 necessary conditions and search PER CONDITION, across source
 *     categories. The replaced instruction asked for "queries that surface the DECISIVE
 *     evidence", which on the as-of date names something that has not happened; the model
 *     dutifully searched for "Pentagon confirms strike on Iran" five weeks before any strike.
 *   - An evidence ledger with direction, strength and a bounded adjustment per row, so the
 *     final number is reconstructible from the rows rather than asserted.
 *   - A named base rate with a stated source, rather than a number pulled from the air.
 *   - The reversal check: if the same evidence would support the opposite conclusion, the
 *     confidence is too high. This is aimed squarely at the status-quo over-anchoring the
 *     runs keep showing.
 *
 * WHAT WAS DELIBERATELY LEFT OUT. The live framework's B1/C1/B2 modules — edge against
 * market price, the comment-section cross-check, Kelly sizing — all read prediction-market
 * prices. This benchmark is market-blind by project decision, so they cannot be carried
 * over, and neither can the live skill's fallback of using market price as the prior when no
 * historical base rate exists. Here the honest fallback is to say there is no base rate.
 */
/** The forecasting method, identical for every arm; only the evidence differs. */
const METHOD = [
  "You are an expert superforecaster in the tradition of Tetlock: you anchor on base rates,",
  "weigh evidence for and against explicitly, consider tail scenarios, and avoid",
  "overconfidence.",
].join("\n");

/** Only for arms that actually have the tools. */
const SEARCH_BRIEF = [
  "You have a news search tool over an archive that ends at the as-of date. Nothing later",
  "exists in it. You are FORECASTING an outcome that is still open on that date — you are not",
  "checking whether it already happened, and searching for the resolving event will find",
  "nothing, because it has not occurred yet.",
].join("\n");

const STEPS_SEARCH = [
  "Work in this order.",
  "",
  "1. PIN THE RESOLUTION BOUNDARY. State exactly what makes this resolve Yes: the trigger,",
  "   the deadline and its timezone, whose action counts, and what source would settle it.",
  "   Name the traps: does a draft or memo count; does one side announcing it count, or must",
  "   both; does third-party reporting count; who can speak for each party. Distinguish",
  "   'negotiations are under way' from 'a settleable agreement exists' — they are not the",
  "   same event and only one of them resolves the question.",
  "",
  "2. DECOMPOSE, THEN SEARCH PER PIECE. Break the outcome into 2-5 conditions that all have",
  "   to hold. For each condition search separately, and vary the angle across: official",
  "   statements and primary documents; major news coverage; reporting from the parties'",
  "   own media; independent analysis; and the political, military or economic backdrop.",
  "   Search for the state of the world a forecaster would weigh — positions, capabilities,",
  "   commitments, scheduled events and deadlines, recent trend, and how often this kind of",
  "   thing has happened before. Read the articles that matter; do not judge from titles.",
  "",
  "3. RANK WHAT YOU FIND. Official data and primary documents outrank major news, which",
  "   outranks named expert analysis, which outranks social or anonymous sourcing. For each",
  "   item ask: is it first-hand or repeated; does the source have a motive; is it still",
  "   current; is it corroborated independently.",
  "",
  "4. START FROM A NAMED BASE RATE. Say where it comes from — a historical frequency, an",
  "   authoritative forecast, or a reference class you construct. If there is no defensible",
  "   base rate, say so rather than inventing one.",
  "",
  "5. BUILD AN EVIDENCE LEDGER. List the evidence that moved you, and for each give the",
  "   direction, its strength, and the size of the adjustment. Keep the adjustment inside",
  "   the strength: strong (official data, an event that has already happened, an",
  "   authoritative institutional forecast) moves 10-20 points; moderate (major news, expert",
  "   analysis, a statistical model) moves 5-10; weak (sentiment, a lone source, indirect",
  "   inference) moves 1-5. The final number must be reachable from the base rate by these",
  "   steps.",
  "",
  "6. REVERSAL CHECK. Ask whether the same evidence, read the other way, would support the",
  "   opposite conclusion. If it would, you are too confident — widen toward the base rate.",
  "   Watch for the standard traps: over-weighting the newest headline, building a story out",
  "   of thin data, ignoring the base rate, and assuming the status quo holds simply because",
  "   the reporting describes it.",
  "",
  "7. COMMIT. Give a single probability and say how confident you are in it.",
  "",
  "Rules. Say 'not found' when the archive does not have something; never invent a source, a",
  "quote or a figure. Do not treat one party's optimistic statement as a concluded agreement.",
  "You are market-blind: never use, infer from, or mention any prediction-market price or",
  "implied probability. You MUST output a probability in [0,1] under all circumstances.",
].join("\n");

/**
 * The same method for the closed-book arm, with the two steps that assume a search tool
 * rewritten around recall instead.
 *
 * Handing this arm the search version instead was a real failure, not a hypothetical: with no
 * tools attached but a prompt telling it to search, the model replied with the literal text of
 * a tool call and no probability. That cell then defaults to 0.5 and reads as a poor forecast
 * rather than as a broken prompt, which is exactly the kind of thing an aggregate hides.
 */
const STEPS_CLOSED = [
  "Work in this order. You have no search tool: reason from what you already know as of the",
  "as-of date, and say plainly when you do not know something.",
  "",
  "1. PIN THE RESOLUTION BOUNDARY. State exactly what makes this resolve Yes: the trigger,",
  "   the deadline and its timezone, whose action counts, and what source would settle it.",
  "   Name the traps: does a draft or memo count; does one side announcing it count, or must",
  "   both; does third-party reporting count; who can speak for each party. Distinguish",
  "   'negotiations are under way' from 'a settleable agreement exists' — they are not the",
  "   same event and only one of them resolves the question.",
  "",
  "2. DECOMPOSE. Break the outcome into 2-5 conditions that all have to hold. For each, set",
  "   out what you know about the state of the world as of the as-of date — positions,",
  "   capabilities, commitments, scheduled events and deadlines, recent trend, and how often",
  "   this kind of thing has happened before.",
  "",
  "3. MARK WHAT YOU ARE UNSURE OF. For each condition, say how firm your knowledge is and",
  "   whether anything could have changed shortly before the as-of date that you would not",
  "   know about. Treat those as uncertainty rather than resolving them by guessing.",
  "",
  "4. START FROM A NAMED BASE RATE. Say where it comes from — a historical frequency, an",
  "   authoritative forecast, or a reference class you construct. If there is no defensible",
  "   base rate, say so rather than inventing one.",
  "",
  "5. BUILD AN EVIDENCE LEDGER. List what moved you, and for each give the direction, its",
  "   strength, and the size of the adjustment. Keep the adjustment inside the strength:",
  "   strong (an event that has already happened, a firm institutional commitment) moves",
  "   10-20 points; moderate (a well-established trend or pattern) moves 5-10; weak (a",
  "   general impression, indirect inference) moves 1-5. The final number must be reachable",
  "   from the base rate by these steps.",
  "",
  "6. REVERSAL CHECK. Ask whether the same reasoning, read the other way, would support the",
  "   opposite conclusion. If it would, you are too confident — widen toward the base rate.",
  "   Watch for the standard traps: over-weighting the most memorable case, building a story",
  "   out of thin knowledge, ignoring the base rate, and assuming the status quo holds simply",
  "   because it is what you remember.",
  "",
  "7. COMMIT. Give a single probability and say how confident you are in it.",
  "",
  "Rules. Never invent a source, a quote or a figure. You are market-blind: never use, infer",
  "from, or mention any prediction-market price or implied probability. You MUST output a",
  "probability in [0,1] under all circumstances.",
].join("\n");

const TOOLS: ToolSpec[] = [
  {
    name: "web_search",
    description:
      "Search a news archive. Returns matching articles with title, url and a short snippet. " +
      "Call it as many times as you need, varying the wording — different phrasings surface " +
      "different articles. Use web_fetch to read anything that looks decisive.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword search query, roughly 3-8 words.",
        },
        num_results: {
          type: "integer",
          description: "How many results to return (default 10).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch the full text of one article by url, as returned by web_search.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
];

/** Frozen browsing uses the same tool budget and trace path as ordinary search. */
function inlineToolsFor(backend: SearchBackend | undefined): ToolSpec[] {
  if (backend?.searchDelivery==='summary') return [{...TOOLS[0]!,description:'Search articles. Returns title, URL, publication date when available, and a short summary quoted from each time-screened article. Use web_fetch on a returned URL to read its cached, approved full text. Both tools count toward the same tool budget.'},{...TOOLS[1]!,description:'Read the cached approved full text of a search result by URL. A returned page is reused without fetching or reviewing it again.'}];
  if (!backend?.browse) {
    if (!backend?.fullTextResults) return TOOLS;
    return [{...TOOLS[0]!, description: "Search articles. Returns title, url and the full admitted article text in snippet. " +
      "Vary query wording to find other relevant articles; web_fetch reads a returned article again."}, TOOLS[1]!];
  }
  const search = TOOLS[0]!;
  return [{ ...search,
    description: "Search captured articles. Ordinary query returns relevant full articles. " +
      "To inspect all captures mentioning an entity within a capture-time range, set entity, " +
      "optionally since/until, and continue with the returned next_cursor. Capture dates describe " +
      "when the crawler saved the page. Choose exactly one of query or entity. " +
      "The date and cursor fields apply only to entity browsing; ordinary query is already limited " +
      "to the prediction cutoff. Browsing is chronological and may include off-topic mentions.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "Keyword query for ordinary relevance search. Use without entity, since, until or cursor." },
      num_results: { type: "integer", description: "Results per page (default 10)." },
      entity: { type: "string", description: "Literal company, person, organization or other entity to browse; all name terms must occur. Use without query." },
      since: { type: "string", description: "Entity browsing only: inclusive capture start, YYYY-MM-DD or ISO timestamp with timezone." },
      until: { type: "string", description: "Entity browsing only: inclusive capture end, YYYY-MM-DD or ISO timestamp with timezone; capped at the prediction cutoff." },
      cursor: { type: "string", description: "next_cursor from the previous page; repeat the same entity and time range." },
    } },
  }, TOOLS[1]!];
}

function toolsFor(backend: SearchBackend | undefined, delivery: ToolDelivery, frozenDelivery: FrozenSearchDelivery): ToolSpec[] {
  const tools = inlineToolsFor(backend);
  if (delivery === 'inline') return tools;
  if (frozenDelivery === 'lead' && backend?.name !== 'mixed') tools[0] = {...tools[0]!, description:
    'Search captured articles. Query returns relevant articles; entity browses captures chronologically. ' +
    'Each result has a title, URL, capture date, and at most 500 characters from the beginning of the original text. ' +
    'This is a leading excerpt, not a summary of the whole article. Use web_fetch with its content_ref and offset=0 ' +
    'to read the same captured article, or next_offset to continue after the excerpt. ' +
    'Choose exactly one of query or entity. since, until and cursor apply only to entity browsing; ' +
    'continue browsing with next_cursor. Capture dates describe when the crawler saved the page; ' +
    'the prediction cutoff is already enforced. Entity browsing may include off-topic mentions.'};
  if (backend?.name === 'mixed') tools[0] = {...TOOLS[0]!, description:
    'Search articles. Results from captured sources contain ' +
    (frozenDelivery === 'lead' ? 'at most 500 characters from the beginning of the original text' : 'original article text') +
    '; web results contain ' + (backend.searchDelivery === 'summary' ? 'an approved source summary' : 'approved article text') +
    '. Use web_fetch to read a returned article. A capture date records when the page was saved. ' +
    'The prediction cutoff is already enforced. Use query to search.'};
  return [
    {...tools[0]!, description: tools[0]!.description +
      ' Long text is returned as an original-text page with content_ref, total_chars and next_offset. ' +
      'Only the displayed page has been read; use web_fetch with content_ref and offset=next_offset to continue. ' +
      'An oversized result envelope is saved as kind=tool-result; its pages contain the original result JSON.'},
    {name: 'web_fetch', description:
      'Read an article by URL, or continue saved text using content_ref. Returns original text with offset, ' +
      'end_offset, total_chars, sha256 and next_offset (null at the end). To continue, pass the same content_ref ' +
      'and offset=next_offset. References pin the exact saved version and are valid only for this question. ' +
      'Offsets and limits are UTF-16 character units. Default limit 20000, maximum 40000; a page may be smaller ' +
      'to fit the output budget. Every page read counts toward the shared tool-call budget.',
      parameters: {type: 'object', properties: {
        url: {type: 'string', description: 'Article URL; use exactly one of url or content_ref.'},
        content_ref: {type: 'string', description: 'Reference returned by a previous search or fetch in this question.'},
        offset: {type: 'integer', minimum: 0, description: 'Start offset; default 0. Use next_offset to continue.'},
        limit: {type: 'integer', minimum: 1, maximum: PAGED_TOOL_POLICY.max_page_chars},
      }},
    },
  ];
}

/** One tool call and what it returned, kept for the archive. */
export interface ToolTrace {
  turn: number;
  call_id?: string;
  name: string;
  args: Record<string, unknown>;
  /** Result count for search, character count for fetch, or the error text. */
  outcome: string;
  /**
   * What the call actually returned. Counts alone cannot answer "did the model have the
   * decisive article and ignore it, or was it never retrieved?", which is the question the
   * evidence evaluation turns on — so the identity of every returned document is kept.
   */
  results?: {
    url: string;
    title: string;
    snippet: string;
    source?: BackendResult["source"];
    crawlDate?: string;
    publishDate?: string;
  }[];
  /** For web_fetch: the document handed to the model, and how much of it. */
  fetched?: {
    url: string;
    title: string;
    chars: number;
    crawlDate?: string;
    publishDate?: string;
    content_ref?: string;
    offset?: number;
    end_offset?: number;
    total_chars?: number;
    sha256?: string;
  };
  /** Filtering-stage counts for backends such as Web-filter. */
  funnel?: SearchFunnelTrace;
  /** Full candidate audit with large bodies replaced by content-addressed blob references. */
  audit?: unknown;
  /** Present when the tool aborted before it could return a model-visible result. */
  error?: ReturnType<typeof serializeError>;
  /** SHA-256 of the exact JSON string sent back to the model as the tool message. */
  content_sha256?: string;
  duration_ms?: number;
}

export class AgenticSearchPredictor implements Predictor {
  readonly id: string;
  private readonly maxToolCalls: number;
  private readonly maxResults: number;
  /** Per-turn reasoning from the most recent predict(), for the transcript archive. */
  lastTurns: { turn: number; text: string; reasoning: string }[] = [];
  private readonly fetchChars: number;
  private readonly toolDelivery: ToolDelivery;
  private readonly frozenSearchDelivery: FrozenSearchDelivery;
  private readonly pages: ToolContentPages;
  private readonly fetchedPages = new Map<string, Promise<{ref?: string; raw: Awaited<ReturnType<AgenticSearchPredictor['runToolRaw']>>}>>();
  private readonly maxInputTokens: number;
  private readonly effort?: string;
  private readonly describeEnv: boolean;
  private readonly ledger: boolean;
  private readonly providedEvidence?: string;
  /** Trace of the most recent predict() call, for the experiment to archive. */
  lastTrace: ToolTrace[] = [];
  /** Partial usage remains available when a later turn fails. */
  lastUsage = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    modelMs: 0,
    toolMs: 0,
  };
  private readonly traceSink?: AgentTraceSink;
  private timingActive=false;
  private timingReady=false;
  private timingBuffer:unknown[]=[];
  private deferredTerminal?:{type:string;data?:unknown};

  constructor(
    private readonly client: LlmClient,
    /**
     * Omitted for the closed-book arm. Leaving it out rather than passing an empty backend
     * keeps that arm on the same predictor, prompt and probability parser as every retrieval
     * arm, so the only thing differing between them is the evidence.
     */
    private readonly backend: SearchBackend | undefined,
    opts: AgenticOptions = {},
  ) {
    this.maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.maxResults = opts.maxResultsPerSearch ?? 20;
    this.fetchChars = opts.fetchChars ?? 0;
    this.toolDelivery = opts.toolDelivery ?? 'inline';
    this.frozenSearchDelivery = opts.frozenSearchDelivery ?? 'fulltext';
    if (this.frozenSearchDelivery === 'lead' &&
        (this.toolDelivery !== 'paged' || (backend?.name !== 'mixed' && (backend?.name !== 'frozen' || !backend.fullTextResults))))
      throw new Error('Frozen lead delivery requires a full-text frozen backend and paged tools');
    if (this.toolDelivery === 'paged' && this.fetchChars !== 0)
      throw new Error('Paged delivery requires fetchChars=0 so all original text remains readable');
    this.maxInputTokens = opts.maxInputTokens ?? 0;
    this.effort = opts.effort;
    this.describeEnv = opts.describeEnvironment ?? false;
    this.ledger = opts.ledger ?? false;
    this.providedEvidence = opts.providedEvidence;
    this.traceSink = opts.trace;
    this.pages = new ToolContentPages(opts.trace);
    // The ledger is part of the predictor's identity, not a runtime detail: a ledger cell and a
    // v1 cell answer the same question under different rules and must never dedupe together in
    // the shared registry.
    this.id =
      `agentic:${client.id}:${backend?.name ?? "closed-book"}:n${this.maxToolCalls}` +
      `${backend?.browse ? ":exclusive-search-arguments-v2" : ""}` +
      `${backend?.browse ? ":browse-input-feedback-v1" : ""}` +
      `${backend && this.toolDelivery === 'paged' ? ':' + PAGED_TOOL_POLICY.version : ''}` +
      `${this.frozenSearchDelivery === 'lead' ? ':' + FROZEN_LEAD_POLICY.version : ''}` +
      `${this.describeEnv ? ":env" : ""}${this.ledger ? ":ledger" : ""}` +
      `${this.providedEvidence ? ":oracle" : ""}` +
      `${this.maxInputTokens > 0 ? `:cap${this.maxInputTokens}` : ""}`;
  }

  private record(type: string, data?: unknown): void {
    if(this.timingActive&&(type==='agent_finished'||type==='agent_failed')){this.deferredTerminal={type,data};return;}
    if(type==='stage_timing'&&!this.timingReady){this.timingBuffer.push(data);return;}

    this.traceSink?.record({ type, data });
    if(type==='agent_started'){this.timingReady=true;for(const event of this.timingBuffer)this.traceSink?.record({type:'stage_timing',data:event});this.timingBuffer=[];}
  }

  /**
   * Run one tool call against whichever world this predictor was given.
   *
   * Returns a JSON string because that is what goes back as the tool message content.
   * Ordinary one-off tool errors remain model-visible; typed shared-infrastructure failures
   * deliberately escape so the experiment scheduler can pause the affected arm.
   */
  private async runTool(
    name: string, args: Record<string, unknown>, asOf: string,
    context?: {question: string; resolutionCriteria: string},
  ): Promise<Awaited<ReturnType<AgenticSearchPredictor['runToolRaw']>>> {
    if (this.toolDelivery === 'inline') return this.runToolRaw(name, args, asOf, context);
    if (name === 'web_fetch') {
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      const ref = typeof args.content_ref === 'string' ? args.content_ref : '';
      const offset = args.offset ?? 0, limit = args.limit ?? PAGED_TOOL_POLICY.page_chars;
      if (!!url === !!ref || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
        typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGED_TOOL_POLICY.max_page_chars)
        return {content: JSON.stringify({error: 'Use exactly one of url or content_ref, an integer offset >= 0, and an integer limit from 1 to 40000.'}), outcome: 'invalid page arguments'};
      let raw: Awaited<ReturnType<AgenticSearchPredictor['runToolRaw']>> | undefined;
      let contentRef = ref;
      if (url) {
        const key = asOf + '\0' + url;
        let saved = this.fetchedPages.get(key);
        const firstFetch = !saved;
        if (!saved) {
          saved = (async () => {
            const raw = await this.runToolRaw(name, {url}, asOf, context);
            const value = JSON.parse(raw.content);
            const metadata = {kind: 'article' as const, url: value.url, title: value.title,
              crawlDate: raw.fetched?.crawlDate, publishDate: raw.fetched?.publishDate};
            const ref = typeof value.text !== 'string' ? undefined : JSON.stringify(metadata).length > 16_000
              ? await this.pages.save(raw.content, {kind: 'tool-result'})
              : await this.pages.save(value.text, metadata);
            return {raw, ref};
          })();
          this.fetchedPages.set(key, saved);
        }
        let savedResult;
        try {savedResult = await saved;} catch (error) {this.fetchedPages.delete(key); throw error;}
        if (!savedResult.ref) {this.fetchedPages.delete(key); return savedResult.raw;}
        raw = firstFetch ? savedResult.raw : undefined;
        contentRef = savedResult.ref;
        // Later URL reads use the saved file, so neither retain the full body in memory
        // nor replay the first fetch's acquisition/review audit as new work.
        this.fetchedPages.set(key, Promise.resolve({ref: contentRef, raw: {content: '', outcome: 'saved article'}}));
      }
      let page;
      try {page = await this.pages.read(contentRef, offset, limit);} catch (error) {
        // Invalid references/offsets are useful model feedback, while I/O/integrity failures escape.
        if (error instanceof Error && /^(Unknown content_ref|offset |limit |Page limit)/.test(error.message))
          return {content: JSON.stringify({error: error.message}), outcome: 'invalid page arguments', audit: raw?.audit};
        throw error;
      }
      return {content: JSON.stringify(page), outcome: `${page.text.length} chars; ${page.end_offset}/${page.total_chars}`,
        ...(page.kind === 'article' && page.url ? {fetched: {url: page.url, title: page.title ?? '', chars: page.text.length,
          crawlDate: page.crawlDate, publishDate: page.publishDate, content_ref: contentRef,
          offset: page.offset, end_offset: page.end_offset, total_chars: page.total_chars, sha256: page.sha256}} : {}),
        audit: raw?.audit};
    }
    const raw = await this.runToolRaw(name, args, asOf, context);
    if (name !== 'web_search') return raw;
    const value = JSON.parse(raw.content);
    if (Array.isArray(value.results)) {
      const textBudget = Math.floor(PAGED_TOOL_POLICY.search_text_budget / Math.max(1, value.results.length));
      for (const result of value.results) {
        if (typeof result.snippet !== 'string') continue;
        if (this.frozenSearchDelivery === 'lead' && (this.backend?.name !== 'mixed' || result.source === 'frozen')) {
          const original = result.snippet;
          const ref = await this.pages.save(original, {kind: 'article',
            ...(typeof result.url === 'string' && result.url.length < 4096 ? {url: result.url} : {}),
            ...(typeof result.title === 'string' && result.title.length < 1024 ? {title: result.title} : {}),
            crawlDate: result.crawlDate, publishDate: result.publishDate, captured_id: result.captured_id});
          const lead = frozenLead(original);
          // Replace the old full-body slice metadata as well as the visible text.
          delete result.nextOffset;
          Object.assign(result, {snippet: lead.text, contentKind: 'leading-excerpt', previewPolicy: FROZEN_LEAD_POLICY.version,
            content_ref: ref, total_chars: original.length, fullBodyChars: original.length,
            offset: lead.offset, end_offset: lead.end_offset, next_offset: lead.end_offset < original.length ? lead.end_offset : null,
            truncated: lead.end_offset < original.length, sha256: sha256(original)});
          continue;
        }
        if (result.snippet.length <= PAGED_TOOL_POLICY.page_chars && JSON.stringify(result).length <= textBudget) continue;
        // Keep article identity outside the stored text. Summary search remains a summary;
        // only full-text backends label the saved text as a complete article.
        const metadata = {kind: (this.backend?.fullTextResults || result.source === 'frozen') && result.contentKind !== 'approved-summary' ? 'article' as const : 'search-excerpt' as const,
          ...(typeof result.url === 'string' && JSON.stringify(result.url).length < 4096 ? {url: result.url} : {}),
          ...(typeof result.title === 'string' && result.title.length < 1024 ? {title: result.title} : {}),
          crawlDate: result.crawlDate, publishDate: result.publishDate, captured_id: result.captured_id};
        if (JSON.stringify(metadata).length > 1024) continue; // Whole-result file fallback below handles large metadata.
        const ref = await this.pages.save(result.snippet, metadata);
        const page = await this.pages.read(ref, 0, PAGED_TOOL_POLICY.page_chars, Math.max(2048, textBudget));
        result.snippet = page.text;
        result.content_ref = ref; result.total_chars = page.total_chars; result.offset = 0;
        result.end_offset = page.end_offset; result.next_offset = page.next_offset; result.sha256 = page.sha256;
      }
    }
    let content = JSON.stringify(value);
    if (content.length > PAGED_TOOL_POLICY.max_result_chars) {
      // Preserve the preview envelope in lead mode, including its original-article
      // references. Legacy fulltext mode retains the exact raw result JSON.
      const ref = await this.pages.save(this.frozenSearchDelivery === 'lead' ? content : raw.content, {kind: 'tool-result'});
      content = JSON.stringify(await this.pages.read(ref));
      return {...raw, content, results: undefined, outcome: raw.outcome + '; saved result JSON, first page'};
    }
    return {...raw, content, results: value.results ?? raw.results};
  }

  private async runToolRaw(
    name: string,
    args: Record<string, unknown>,
    asOf: string,
    context?: { question: string; resolutionCriteria: string },
  ): Promise<{
    content: string;
    outcome: string;
    results?: {
      url: string;
      title: string;
      snippet: string;
      source?: BackendResult["source"];
      crawlDate?: string;
      publishDate?: string;
    }[];
    fetched?: ToolTrace["fetched"];
    funnel?: SearchFunnelTrace;
    audit?: RetrievalAuditTrace;
  }> {
    if (name === "web_search") {
      const query = String(args.query ?? "").trim();
      const entity = String(args.entity ?? "").trim();
      if (query && entity) return {
        content: JSON.stringify({ error: "Choose exactly one of query (relevance search) or entity (chronological capture browsing). Neither has been executed; query is not a filter on entity browsing." }),
        outcome: "ambiguous query and entity",
      };
      if (!query && !entity)
        return {
          content: JSON.stringify({ error: "query is required" }),
          outcome: "empty query",
        };
      const n = Math.min(
        Math.max(this.backend?.name === 'mixed' ? Math.trunc(Number(args.num_results ?? 10) || 10) : Number(args.num_results ?? 10) || 10, 1),
        this.maxResults,
      );
      // No backend means the closed-book arm, which is given no tools, so a call here would
      // mean the tool list and the backend had drifted apart.
      if (!this.backend)
        throw new Error("web_search called on a closed-book predictor");
      if (entity) {
        if (!this.backend.browse) return { content: JSON.stringify({ error: "entity browsing is unavailable for this source" }), outcome: "browse unavailable" };
        const page = await this.backend.browse({ entity, limit: Math.floor(n),
          ...(args.since == null ? {} : { since: String(args.since) }),
          ...(args.until == null ? {} : { until: String(args.until) }),
          ...(args.cursor == null ? {} : { cursor: String(args.cursor) }),
        }, asOf, context);
        const results = page.results.map(r => ({ url: r.url, title: r.title, snippet: r.body,
          source: "frozen" as const, crawlDate: r.crawlDate, captured_id: r.capturedId }));
        return { content: JSON.stringify({ results, next_cursor: page.nextCursor, capture_range: page.query }),
          outcome: `${results.length} captures${page.nextCursor ? "; more available" : ""}`, results };
      }
      if (args.cursor != null || args.since != null || args.until != null)
        return { content: JSON.stringify({ error: "since, until and cursor apply only to entity browsing. For ordinary relevance search, send query without these fields; the prediction cutoff is already enforced." }), outcome: "browse requires entity" };
      const searched = this.backend.searchWithTrace
        ? await this.backend.searchWithTrace(query, n, asOf, context)
        : {
            results: await this.backend.search(query, n, asOf),
            funnel: undefined,
            audit: undefined,
          };
      const results = searched.results;
      return {
        content: JSON.stringify({ results }),
        outcome: `${results.length} results`,
        results: results.map((r) => ({
          url: r.url,
          title: r.title,
          snippet: r.snippet,
          source: r.source,
          crawlDate: r.crawlDate,
          publishDate: r.publishDate,
        })),
        funnel: searched.funnel,
        audit: searched.audit,
      };
    }
    if (name === "web_fetch") {
      const url = String(args.url ?? "").trim();
      if (!this.backend)
        throw new Error("web_fetch called on a closed-book predictor");
      const fetchedWithTrace = this.backend.fetchWithTrace
        ? await this.backend.fetchWithTrace(url, asOf, context)
        : { doc: await this.backend.fetch(url, asOf), audit: undefined };
      const doc = fetchedWithTrace.doc;
      if (!doc) {
        // Deliberately uninformative, exactly like a dead link. Distinguishing "not in the
        // archive" from "withheld for leaking" would announce the benchmark and, worse, tell
        // the model that this particular page said something about the outcome.
        return {
          content: JSON.stringify({ error: "could not fetch this URL" }),
          outcome: "fetch failed",
          audit: fetchedWithTrace.audit,
        };
      }
      const text =
        this.fetchChars > 0 ? doc.body.slice(0, this.fetchChars) : doc.body;
      return {
        content: JSON.stringify({ title: doc.title, url: doc.url, text }),
        outcome: `${text.length} chars`,
        fetched: {
          url: doc.url,
          title: doc.title,
          chars: text.length,
          crawlDate: doc.crawlDate,
          publishDate: doc.publishDate,
        },
        audit: fetchedWithTrace.audit,
      };
    }
    return {
      content: JSON.stringify({ error: `unknown tool ${name}` }),
      outcome: "unknown tool",
    };
  }

  /**
   * Keep every candidate decision in JSONL while moving large page bodies into the run-level
   * content-addressed blob store. Nothing in this method changes the model-visible tool result.
   */
  private archiveRetrievalAudit(audit: RetrievalAuditTrace | undefined): unknown {
    if (!audit) return undefined;
    return {
      ...audit,
      candidates: audit.candidates.map((candidate) => {
        if (!candidate.fetch) return candidate;
        const { body, ...fetch } = candidate.fetch;
        const bodyBlob = this.traceSink?.storeTextBlob?.(body);
        return {
          ...candidate,
          fetch: {
            ...fetch,
            body_sha256: sha256(body),
            body_chars: body.length,
            body_blob: bodyBlob ?? null,
          },
        };
      }),
    };
  }

  private archiveToolContent(name: string, content: string): {
    content: string | null;
    modelVisibleContent?: unknown;
  } {
    if (name !== "web_fetch" || !this.traceSink?.storeTextBlob)
      return { content };
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (typeof parsed.text !== "string") return { content };
      const textBlob = this.traceSink.storeTextBlob(parsed.text);
      const { text: _text, ...metadata } = parsed;
      return {
        content: null,
        modelVisibleContent: {
          ...metadata,
          text_blob: textBlob,
          reconstruction: "JSON.stringify({...metadata,text:<decoded text_blob>})",
        },
      };
    } catch {
      return { content };
    }
  }

  async predict(
    question: Question,
    env: RetrievalEnv,
    budget: BudgetTier,
  ): Promise<Prediction> {
    this.timingActive=true;this.timingReady=false;this.timingBuffer=[];this.deferredTerminal=undefined;
    const session = this.client.openForecast?.();
    try{return await withTiming({questionId:question.question_id},event=>this.record('stage_timing',event),()=>timed('prediction',()=>this.predictTimed(question,env,budget,session ?? this.client)));}
    finally{session?.close();await this.pages.close();this.fetchedPages.clear();this.timingActive=false;this.timingReady=true;for(const event of this.timingBuffer)this.record('stage_timing',event);this.timingBuffer=[];
      this.flushTerminal();}

  }
  private flushTerminal(){const terminal=this.deferredTerminal;if(terminal)this.record(terminal.type,terminal.data);this.deferredTerminal=undefined;}
  private async predictTimed(question:Question,env:RetrievalEnv,budget:BudgetTier,client:LlmClient):Promise<Prediction> {
    void env; // this predictor owns its own retrieval; the env seam does not apply
    // The as-of date is the whole experiment: it is the moment the model forecasts from, and
    // it gates every retrieved page. Falling back to resolution_date when it is missing is not
    // a safe default — resolution_date is the moment the market actually SETTLED, so the
    // fallback would silently place the model AFTER the event and hand it the answer. On the
    // current 1,664-question sheet, resolution_date matches the deadline stated in the title
    // for only 10.2% of questions; 64 differ by more than 30 days because the market settled
    // early. A question set that forgets as_of_date must fail loudly, not score well.
    if (!question.as_of_date) {
      throw new Error(
        `question ${question.question_id} has no as_of_date. Refusing to fall back to ` +
          `resolution_date (${question.resolution_date}) — that is the settlement moment, ` +
          `so the model would be forecasting from after the event.`,
      );
    }
    const asOf = question.as_of_date;
    const structured = question.response_format === "raven.forecast.v2.1";
    if (structured && (this.ledger || !question.forecast_prompt || !question.as_of_date || !question.prediction_cutoff_utc))
      throw new Error("Structured forecast requires explicit dates/prompt and ledger=false");
    const trace: ToolTrace[] = [];
    /** Reasoning emitted on each tool-calling turn, in order. */
    const turns: { turn: number; text: string; reasoning: string }[] = [];
    /** Every document the model actually pulled the full text of — the evidence it read. */
    const fetchedDocs: NonNullable<ToolTrace["fetched"]>[] = [];
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let modelMs = 0;
    let toolMs = 0;

    const messages: LlmMessage[] = [
      {
        role: "system",
        // The closed-book arm gets the same method and the same output contract, minus the
        // paragraph about the archive. Leaving that paragraph in told a model with no tools
        // to go and search, and it answered with the literal text of a tool call instead of a
        // probability — a failed cell that would have defaulted to 0.5 and read as a poor
        // forecast rather than as a broken prompt.
        content: [
          METHOD,
          this.backend ? SEARCH_BRIEF : null,
          this.backend && this.describeEnv ? ENVIRONMENT_BRIEF : null,
          this.backend ? STEPS_SEARCH : STEPS_CLOSED,
          // Appended rather than spliced into the step list so that the v1 system prompt stays
          // byte-identical when the ledger is off — the control arm of the A/B is the runs
          // already in the registry, and a whitespace change would quietly break that link.
          this.ledger ? LEDGER_INSTRUCTIONS : null,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      {
        role: "user",
        content: [
          `QUESTION: ${question.question_text}`,
          `RESOLUTION CRITERIA: ${question.resolution_criteria}`,
          `AS-OF DATE (you are forecasting from this moment; nothing after it exists): ${asOf}`,
          ``,
          // Inserted verbatim and nowhere else. Every other byte of this arm is identical to the
          // closed-book arm, so any difference in score is the evidence and only the evidence.
          ...(this.providedEvidence
            ? [
                `EVIDENCE AVAILABLE AS OF THAT DATE. This is what a well-informed forecaster`,
                `would have known on the as-of date. Every item was public by then. Treat it as`,
                `established, weigh it, and note that it is not necessarily complete.`,
                ``,
                this.providedEvidence,
                ``,
              ]
            : []),
          `Work through the seven steps in your instructions, using web_search and web_fetch.`,
          `Show your working for each: the resolution boundary and its traps; the 2-5`,
          `conditions and what you searched for each; the base rate and where it came from;`,
          `the evidence ledger with direction, strength and adjustment; the reversal check.`,
          ``,
          `This is NOT a multiple choice question. Do not answer Yes/No or A/B. Answer with`,
          `a probability: how likely the event is, as a number between 0 and 1. 0.03 and 0.45`,
          `are different answers even though both lean No, and the difference is what is being`,
          `scored — a confident 0.03 that turns out right beats a hedged 0.45.`,
          ``,
          ...(this.ledger
            ? [
                `Do NOT state a final probability yourself. End with the JSON ledger described`,
                `in your instructions — a base rate and classified entries — and nothing after`,
                `it. The probability is computed from that object.`,
              ]
            : [
                `On the final line output the probability as a number in asterisks, e.g. *0.37*,`,
                `and nothing after it.`,
              ]),
        ].join("\n"),
      },
    ];
    if (structured) {
      messages.splice(0, messages.length,
        { role: "system", content: [
          "Follow the historical information boundary and JSON response contract in the question.",
          this.backend ? SEARCH_BRIEF : "No retrieval tools are available for this forecast.",
        ].join("\n\n") },
        { role: "user", content: question.forecast_prompt! +
          (this.providedEvidence ? "\n\nEvidence provided for the information as-of date:\n" + this.providedEvidence : "") },
      );
    }
    // Keep the live arrays on the instance from the first instruction onward.  If a provider
    // fails on turn 12, the runner can still index the first 11 turns instead of seeing the
    // empty arrays that used to be assigned only after the loop succeeded.
    this.lastTrace = trace;
    this.lastTurns = turns;
    this.lastUsage = {
      costUsd,
      inputTokens,
      outputTokens,
      reasoningTokens,
      modelMs,
      toolMs,
    };

    const tools = toolsFor(this.backend, this.toolDelivery, this.frozenSearchDelivery);
    let used = 0;
    let final = "";
    let budgetNoticeAdded = false;
    this.record("agent_started", {
      predictor_id: this.id,
      llm: { id: this.client.id, ...(this.client.traceMetadata ?? {}) },
      question: {
        question_id: question.question_id,
        question_text: question.question_text,
        resolution_criteria: question.resolution_criteria,
        resolution_date: question.resolution_date,
        as_of_date: asOf,
        ...(structured ? { prediction_cutoff_utc: question.prediction_cutoff_utc, response_format: question.response_format } : {}),
        category: question.category,
        difficulty_level: question.difficulty_level,
        source: question.source,
        language: question.language,
      },
      budget_tier: String(budget),
      options: {
        max_tool_calls: this.maxToolCalls,
        max_results_per_search: this.maxResults,
        fetch_chars: this.fetchChars,
        tool_delivery: this.toolDelivery,
        tool_delivery_policy: this.toolDelivery === 'paged' ? PAGED_TOOL_POLICY : null,
        ...(this.frozenSearchDelivery === 'lead' ? {frozen_search_delivery: 'lead', frozen_search_policy: FROZEN_LEAD_POLICY} : {}),
        max_input_tokens: this.maxInputTokens,
        effort: this.effort ?? null,
        describe_environment: this.describeEnv,
      },
      initial_messages: messages,
      tools: this.backend ? tools : [],
      conversation_sha256: timedSync('context.hash',()=>sha256Json(messages)),
    });

    try {
      // +2 turns of slack past the budget: one to deliver the "answer now" instruction and one
      // for the model to comply. Without it the loop can end on a tool-call turn with no text.
      for (let turn = 0; turn < this.maxToolCalls + 2; turn++) {
        // Retry the TURN, not just the HTTP request.  Both layers are separately recorded:
        // `model_attempt_*` is the conversation replay; `llm_transport` is the HTTP retry.
        let res: Awaited<ReturnType<typeof this.client.complete>> | undefined;
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3 && !res; attempt++) {
          if (attempt > 0) {
            const delayMs = 3000 * attempt;
            this.record("model_retry_wait", { turn, attempt: attempt + 1, delay_ms: delayMs });
            await new Promise((r) => setTimeout(r, delayMs));
          }
          // Sized per attempt, not once per turn: a retry replays the same conversation, and a
          // request that was already over the ceiling must be trimmed again or it fails again.
          const capped = timedSync("context.cap", () =>
            capConversation(messages, this.maxInputTokens),
          );
          if (capped.dropped > 0 || !capped.fits)
            this.record("context_capped", {
              turn,
              attempt: attempt + 1,
              max_input_tokens: this.maxInputTokens,
              dropped_tool_results: capped.dropped,
              estimated_tokens_before: capped.estimatedBefore,
              estimated_tokens_after: capped.estimatedAfter,
              // False means the provider is about to refuse this request. Recorded rather than
              // worked around, so the cell fails and is counted instead of being answered from
              // a mutilated question.
              fits: capped.fits,
            });
          const callStarted = performance.now();
          this.record("model_attempt_started", {
            turn,
            attempt: attempt + 1,
            message_count: messages.length,
            conversation_sha256: timedSync('context.hash',()=>sha256Json(messages)),
            tools_enabled: used < this.maxToolCalls,
            tool_names: used < this.maxToolCalls ? tools.map((t) => t.name) : [],
            effort: this.effort ?? null,
          });
          try {
            res = await timed("prediction.model",()=>client.complete({
              prompt: "",
              messages: capped.messages,
              tools: this.backend && used < this.maxToolCalls ? tools : undefined,
              effort: this.effort,
              onTrace: (event) =>
                this.record("llm_transport", {
                  turn,
                  model_attempt: attempt + 1,
                  event,
                }),
            }));
            const durationMs = Math.round(performance.now() - callStarted);
            modelMs += durationMs;
            this.record("assistant_message", {
              turn,
              attempt: attempt + 1,
              duration_ms: durationMs,
              role: "assistant",
              content: res.text,
              reasoning: res.reasoning ?? "",
              reasoning_capture: res.reasoningCapture ?? null,
              tool_calls: res.toolCalls ?? [],
              finish_reason: res.finishReason ?? null,
              usage: {
                input_tokens: res.inputTokens,
                output_tokens: res.outputTokens,
                cached_input_tokens: res.cachedInputTokens ?? null,
                cache_write_input_tokens: res.cacheWriteInputTokens ?? null,
                reasoning_tokens: res.reasoningTokens ?? null,
                cost_usd: res.costUsd,
              },
              provider: res.provider ?? null,
            });
          } catch (error) {
            lastErr = error;
            const durationMs = Math.round(performance.now() - callStarted);
            modelMs += durationMs;
            this.record("model_attempt_failed", {
              turn,
              attempt: attempt + 1,
              duration_ms: durationMs,
              error: serializeError(error),
            });
            if (isNonRetryableProviderApiError(error)) throw error;
          }
        }
        if (!res)
          throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
        costUsd += res.costUsd;
        inputTokens += res.inputTokens;
        outputTokens += res.outputTokens;
        reasoningTokens += res.reasoningTokens ?? 0;
        this.lastUsage = {
          costUsd,
          inputTokens,
          outputTokens,
          reasoningTokens,
          modelMs,
          toolMs,
        };

        if (!res.toolCalls?.length) {
          final = res.text;
          messages.push({ role: "assistant", content: res.text, reasoning: res.reasoning ?? "" });
          if (res.reasoning?.trim())
            turns.push({ turn, text: "", reasoning: res.reasoning });
          break;
        }
        // The text on a tool-calling turn is where the model says WHY it is about to search.
        if (res.reasoning?.trim() || res.text?.trim())
          turns.push({
            turn,
            text: res.text ?? "",
            reasoning: res.reasoning ?? "",
          });
        // One question is one tool task. Its turns return with their own reasoning where the
        // provider reads it (retrieval-infra REASONING_REPLAY_POLICY); questions never share
        // a message list, so reasoning cannot reach another question.
        messages.push({
          role: "assistant",
          content: res.text,
          toolCalls: res.toolCalls,
          reasoning: res.reasoning ?? "",
        });
        // Providers may return several parallel calls in one assistant message. Reserve the
        // remaining budget before starting any of them, then run the admitted calls together.
        // Results are appended to the conversation in provider order below even when a later
        // call finishes first, which keeps the tool protocol deterministic without serialising
        // the network work.
        const remainingBudget = Math.max(0, this.maxToolCalls - used);
        const admitted = res.toolCalls.slice(0, remainingBudget);
        const admittedIds = new Set(admitted.map((call) => call.id));
        const executed = await Promise.all(
          admitted.map(async (call) => timed("tool",async()=>{
            const toolStarted = performance.now();
            this.record("tool_call_started", {
              turn,
              call_id: call.id,
              name: call.name,
              args: call.args,
            });
            let content: string;
            let outcome: string;
            let results: ToolTrace["results"];
            let fetched: ToolTrace["fetched"];
            let funnel: ToolTrace["funnel"];
            let audit: RetrievalAuditTrace | undefined;
            let fatalError: unknown;
            let archivedError: ReturnType<typeof serializeError> | undefined;
            try {
              ({ content, outcome, results, fetched, funnel, audit } = await this.runTool(
                call.name,
                call.args,
                asOf,
                { question: question.question_text, resolutionCriteria: question.resolution_criteria },
              ));
            } catch (error) {
              // Caller errors expose bounded corrective guidance; private backend diagnostics
              // stay in the archive. A backend exception must not erase preceding turns.
              const inputError = isRetrievalInputError(error);
              content = JSON.stringify({ error: inputError ? error.message : "tool execution failed" });
              outcome = inputError ? "invalid tool arguments" : "tool execution failed";
              archivedError = serializeError(error);
              this.record("tool_call_error", {
                turn,
                call_id: call.id,
                name: call.name,
                args: call.args,
                duration_ms: Math.round(performance.now() - toolStarted),
                error: archivedError,
                model_visible_content: content,
              });
              if (isRetrievalInfrastructureError(error) || error instanceof ToolContentStorageError) fatalError = error;
            }
            const durationMs = Math.round(performance.now() - toolStarted);
            const archivedAudit = timedSync('tool.archive',()=>this.archiveRetrievalAudit(audit));
            const result = {
              call,
              content,
              outcome,
              results,
              fetched,
              funnel,
              archivedAudit,
              durationMs,
              fatalError,
              archivedError,
            };
            if (!fatalError) {
              if (archivedAudit) {
                this.record("retrieval_audit", {
                  turn,
                  call_id: call.id,
                  name: call.name,
                  audit: archivedAudit,
                });
              }
              const archivedContent = timedSync('tool.archive',()=>this.archiveToolContent(call.name, content));
              this.record("tool_call_finished", {
                turn,
                call_id: call.id,
                name: call.name,
                args: call.args,
                duration_ms: durationMs,
                outcome,
                content: archivedContent.content,
                model_visible_content: archivedContent.modelVisibleContent ?? null,
                content_sha256: sha256(content),
                results: results ?? null,
                fetched: fetched ?? null,
                funnel: funnel ?? null,
              });
            }
            return result;
          },{toolCallId:call.id})),
        );
        const executedById = new Map(executed.map((result) => [result.call.id, result]));
        let parallelFatalError: unknown;

        for (const call of res.toolCalls) {
          // Answer every excess call with an explicit tool result, so the cap is real while the
          // provider conversation remains protocol-valid.
          if (!admittedIds.has(call.id)) {
            const content = JSON.stringify({ error: "research budget exhausted" });
            const skipped: ToolTrace = {
              turn,
              call_id: call.id,
              name: call.name,
              args: call.args,
              outcome: "budget exhausted; not executed",
              content_sha256: sha256(content),
              duration_ms: 0,
            };
            trace.push(skipped);
            messages.push({ role: "tool", toolCallId: call.id, content });
            this.record("tool_call_skipped", {
              turn,
              call_id: call.id,
              name: call.name,
              args: call.args,
              reason: "research budget exhausted",
              model_visible_content: content,
            });
            continue;
          }
          const result = executedById.get(call.id)!;
          const {
            content,
            outcome,
            results,
            fetched,
            funnel,
            archivedAudit,
            durationMs,
            fatalError,
            archivedError,
          } = result;
          toolMs += durationMs;
          trace.push({
            turn,
            call_id: call.id,
            name: call.name,
            args: call.args,
            outcome,
            results,
            fetched,
            funnel,
            audit: archivedAudit,
            error: archivedError,
            content_sha256: sha256(content),
            duration_ms: durationMs,
          });
          if (fetched) fetchedDocs.push(fetched);
          used++;
          if (fatalError) parallelFatalError ??= fatalError;
          else messages.push({ role: "tool", toolCallId: call.id, content });
          this.lastUsage = {
            costUsd,
            inputTokens,
            outputTokens,
            reasoningTokens,
            modelMs,
            toolMs,
          };
        }
        // Wait for every admitted call before propagating a shared-infrastructure failure. This
        // prevents sibling promises from writing late trace events after agent_failed.
        if (parallelFatalError) throw parallelFatalError;
        if (used >= this.maxToolCalls && !budgetNoticeAdded) {
          const content =
            "You have used your research budget. Do not search again. " +
            (structured
              ? "Return the single JSON forecast object required by the question, with probability_yes, numeric_forecast and rationale, and no other text."
              : this.ledger
              ? "Give your final answer now, ending with the JSON ledger and nothing after it."
              : "Give your final answer now, ending with the probability in asterisks, e.g. *0.37*.");
          messages.push({ role: "user", content });
          budgetNoticeAdded = true;
          this.record("user_message_added", {
            reason: "tool_budget_exhausted",
            role: "user",
            content,
          });
        }
      }

      let p: number | null;
      let structuredAnswer: ForecastResponse | null = null;
      let formatRepairs: string[] = [];
      let computation: LedgerComputation | null = null;
      let ledgerFallback = false;
      if (structured) {
        const parsed = parseForecastAnswer(final, question.numeric_target_unit ?? null);
        structuredAnswer = parsed.answer;
        formatRepairs = parsed.format_repairs;
        // Counted apart from strict successes; the raw reply stays in final_answer unchanged.
        if (formatRepairs.length)
          this.record("forecast_format_repaired", { policy: FORECAST_PARSE_POLICY, repairs: formatRepairs });
        p = structuredAnswer.probability_yes;
      } else if (this.ledger) {
        const parsed = parseLedger(final);
        if (parsed) {
          // SCORED: the model's own number. The shadow below is recorded for offline analysis
          // and never substituted — a score produced by our points table would measure the
          // table rather than the model, and the table was derived from these same failures.
          p = parsed.final_probability ?? parseProbability(final);
          computation = computeProbability(parsed);
          this.record("ledger_computed", {
            question_shape: parsed.question_shape,
            window_days: parsed.window_days,
            base_rate: computation.baseRate,
            base_rate_source: parsed.base_rate_source,
            entries: parsed.entries,
            model_probability: parsed.final_probability,
            // What POINTS would have produced. A hypothesis to be tested offline on held-out
            // questions, not a rule anything obeyed during this run.
            shadow_probability: computation.probability,
            shadow_points_by_type: computation.pointsByType,
            shadow_total_points: computation.totalPoints,
            shadow_capped_types: computation.cappedTypes,
            unknown_types: computation.unknownTypes,
            unasserted_absence: computation.droppedAbsence,
          });
          if (parsed.final_probability == null) {
            // The ledger parsed but carried no forecast, so the number came from the prose.
            // Recorded because it is a different failure from an unparseable ledger.
            this.record("ledger_missing_probability", { recovered_probability: p });
          }
        } else {
          // A ledger that will not parse is a FORMAT failure, and scoring it as if it were a
          // forecasting failure would let the A/B credit v1 for vNext's JSON problems. So the
          // fallback is loud: the cell still produces a number, and the trace says why, so the
          // analysis can report the fallback rate and exclude these cells if it is material.
          ledgerFallback = true;
          p = parseProbability(final);
          this.record("ledger_parse_failed", {
            reason: "no JSON object with base_rate and entries in final answer",
            recovered_probability: p,
            final_answer_tail: final.slice(-400),
          });
        }
      } else {
        p = parseProbability(final);
      }
      if (p == null) {
        throw new Error(
          `no probability in final answer after ${used} tool calls (${final.length} chars): ${final.slice(-160)}`,
        );
      }

      const predictedAt = new Date().toISOString();
      this.record("agent_finished", {
        probability: p,
        ...(structuredAnswer ? { numeric_forecast: structuredAnswer.numeric_forecast, format_repairs: formatRepairs } : {}),
        ledger_mode: this.ledger,
        ledger_fallback: ledgerFallback,
        ledger: computation
          ? {
              base_rate: computation.baseRate,
              shadow_probability: computation.probability,
              shadow_total_points: computation.totalPoints,
              shadow_capped_types: computation.cappedTypes,
            }
          : null,
        final_answer: final,
        tool_calls_executed: used,
        reasoning_turns: turns.length,
        sources_read: [...new Set(fetchedDocs.map((d) => d.url))],
        usage: {
          cost_usd: costUsd,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          reasoning_tokens: reasoningTokens,
          model_ms: modelMs,
          tool_ms: toolMs,
        },
        predicted_at_utc: predictedAt,
        final_conversation_sha256: timedSync('context.hash',()=>sha256Json(messages)),
      });

      return {
        question_id: question.question_id,
        probabilities: [p],
        ...(structuredAnswer ? { numeric_forecast: structuredAnswer.numeric_forecast, format_repairs: formatRepairs } : {}),
        rationale_md:
          `Model: ${this.id} · tool calls: ${used}\n\n` +
          trace
            .map(
              (t) =>
                `- turn ${t.turn} ${t.name}(${JSON.stringify(t.args)}) → ${t.outcome}`,
            )
            .join("\n") +
          `\n\n--- final answer ---\n${final}`,
        sources: [...new Map(fetchedDocs.map((d) => [d.url, d])).values()].map(
          (d) => ({
            title: d.title,
            url: d.url,
            retrieved_at_utc: predictedAt,
          }),
        ),
        predictor_id: this.id,
        budget_tier: String(budget),
        cost_usd: costUsd,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        predicted_at_utc: predictedAt,
      };
    } catch (error) {
      // Do not let a secondary archive failure hide the original error.  If the archive itself
      // caused the failure this best-effort write will fail too and the original remains loud.
      try {
        this.record("agent_failed", {
          error: serializeError(error),
          partial_final_answer: final,
          tool_calls_executed: used,
          reasoning_turns: turns.length,
          usage: this.lastUsage,
          conversation_sha256: timedSync('context.hash',()=>sha256Json(messages)),
        });
      } catch {
        // The runner will mark the cell failed and close whatever was durably written.
      }
      throw error;
    }
  }
}
