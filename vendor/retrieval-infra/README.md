# FABench archive environment

This package lets a forecasting agent search the world as it was on a past date, the forecast date (`--as-of` on the command line). FABench uses it for every retrieval setting, and you can also use it on its own. It provides four things.

**Frozen news search.** `tools/build-frozen-index.ts` builds a full-text search index (SQLite FTS5) over a corpus database of news articles and admits only articles captured before the forecast date. Word statistics, BM25 scores and returned text therefore all come from that period. Article text is read from the corpus database and checked against its stored SHA-256. The index refuses to run if it is incomplete, if the corpus has changed or if it was built for a different date.

**Wikipedia at the forecast date.** A manifest pins each page to its last revision before the forecast date, and a revision cache serves the text. Frozen search ranks Wikipedia pages and news articles together.

**Filtered web search.** Live search results are fetched, their main text and tables are extracted, and a review model dates each page and removes material that could reveal later events. The review reads each page as it is today and withholds it when that text reveals later events. Its judgements, unknowns and failures are recorded separately.

**Capture, replay and comparison.** Search requests and responses can be captured and replayed. `tools/retrieval-fidelity.py` and `tools/trajectory-fidelity.py` compare result sets and fact trajectories between retrieval settings.

The package holds code only. The FABench dataset supplies the news archive and the Wikipedia lists, and you provide the API keys.

## Install and test

You need Node 22 (22.13 or later), pnpm 11 and Python 3.12.

```bash
pnpm install --frozen-lockfile
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
export HTMLDATE_PYTHON="$PWD/.venv/bin/python"
.venv/bin/python tools/install_browser_runtime.py   # optional browser for pages that need JavaScript
bash tools/build-native.sh                          # optional faster BM25 with identical ranking
pnpm typecheck && pnpm test && pnpm test:python
```

Run `pnpm test:python` with the virtual environment active, or call `.venv/bin/python -m unittest discover -s tools -p 'test_*.py'` directly.

## Command line

```bash
node bin/fabench-retrieval.mjs search --mode frozen --as-of 2026-07-01T00:00:00Z \
  --corpus /path/to/ccnews-before-20260701-v1.db --query 'S&P 500 outlook' --n 5

node bin/fabench-retrieval.mjs search --mode web-filter --as-of 2026-07-01T00:00:00Z \
  --question 'What was the baseline before July 2026?' --query 'historical background' --n 5

node bin/fabench-retrieval.mjs browse --mode frozen --as-of 2026-07-01T00:00:00Z \
  --corpus /path/to/ccnews-before-20260701-v1.db --entity 'Starbucks' --since 2026-01-01 --until 2026-06-30 --limit 20
```

`--corpus` takes the search index built by `build-frozen-index.ts`. Each command prints one JSON object with `identity`, `results` (or `doc`) and `stats`, and exits with a non-zero status on failure. Web mode calls the search provider, the page reader and the review model, so it costs money. Reviews and query records are written to `results/retrieval-artifacts` in the working directory, or below `FABENCH_RESULTS_DIR` if it is set.

## TypeScript

```ts
import { createRetrievalSession } from './src/index.js';

const retrieval = createRetrievalSession({
  mode: 'frozen', asOf: '2026-07-01T00:00:00Z', corpusPath: process.env.FABENCH_CORPUS_DB,
});
try {
  const results = await retrieval.search('UK Met Office temperature forecast', 5);
  const page = results[0] ? await retrieval.fetch(results[0].url) : null;
  // Store retrieval.identity together with the results the model actually saw.
} finally {
  retrieval.close();
}
```

Experiment code uses `createRetrievalRuntime`, which combines the same backends with a pool of read-only frozen search workers (by default one per core, at most four).

## Configuration

API keys come from the environment or an env file (`FABENCH_TEAM_ENV_FILE`, otherwise `.env` in the working directory). Installation settings come from environment variables such as `FABENCH_SHARED_ROOT` and `FABENCH_HTTP_USER_AGENT`, or from the JSON file named by `FABENCH_PATHS_CONFIG`. They include the optional shared root for team servers, the User-Agent for Wikipedia and web archives, and former names of renamed variables; see `src/site-config.ts` and the benchmark's `docs/configuration.md`.

## License

Apache License 2.0; see `LICENSE` and `NOTICE`.
