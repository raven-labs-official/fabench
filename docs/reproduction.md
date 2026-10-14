# Reproduction

This guide prepares the questions, the news archive and the Wikipedia snapshot, and then runs agents on the benchmark with the protocol of the leaderboard runs. A new run is a new experiment. Providers update their models and the live web keeps changing, so new forecasts will differ from those on the leaderboard in the [README](../README.md#leaderboard).

All data comes from the Hugging Face dataset [raven-labs-official/fabench](https://huggingface.co/datasets/raven-labs-official/fabench), whose card describes every file.

## 1. Install

You need Node 22 (22.13 or later), pnpm 11 and Python 3.12. A C compiler is needed only for the optional native ranking extension.

```bash
pnpm install --frozen-lockfile
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r vendor/retrieval-infra/requirements.txt -r requirements-dev.txt
export HTMLDATE_PYTHON="$PWD/.venv/bin/python"
```

The Python environment provides the page dating and extraction helpers of the archive environment, `pyarrow` for reading the dataset and the `hf` download command. The commands below assume that it is active.

Two steps are optional. The first installs a browser for web pages that need JavaScript; the second builds a native extension that makes frozen ranking faster without changing its results.

```bash
python vendor/retrieval-infra/tools/install_browser_runtime.py
bash vendor/retrieval-infra/tools/build-native.sh
```

To check the installation without calling a model or the network, run:

```bash
pnpm typecheck
pnpm test
python -m unittest discover -s tools -p 'test_*.py'
pnpm lint
pnpm example:analysis
```

The archive environment in `vendor/retrieval-infra/` has its own tests: `cd vendor/retrieval-infra && pnpm install --frozen-lockfile && pnpm test && pnpm test:python`.

## 2. Set up model runs

[Configuration](configuration.md) describes every setting. On a single machine, this is enough:

```bash
cp .env.example .env                                   # add the API keys you need
cp config/paths.example.json config/paths.local.json   # set dataRoot
export FABENCH_PATHS_CONFIG="$PWD/config/paths.local.json"
export FABENCH_DATA_ROOT=/path/to/your/dataRoot          # the same directory, for the commands below
```

Which keys you need depends on the setting. The none setting needs only the key of the model under test. The frozen setting also needs the news archive and the Wikipedia snapshot from section 3. The web-filter and mixed settings (`web-filter` and `both` on the command line) also need a search key (`SERPER_API_KEY`) and a page reader key (`JINA_API_KEY`). They also need the key of the review model, which is DeepSeek by default.

## 3. Prepare the July 2026 data

The `july-2026-paper` preset runs the leaderboard's protocol on all 287 questions for the forecast date 2026-07-01, and `july-2026-formal` runs it on the 254 questions of our own set. Both read their files from the directory layout in [configuration, section 3](configuration.md#3-data-root-and-the-july-2026-preset). The following steps fill that layout from the dataset. They download 21 GB and need about 150 GB more disk: about 100 GB for the corpus database and about 50 GB for the search index.

### Questions

```bash
hf download raven-labs-official/fabench --repo-type dataset --local-dir fabench-data \
  --include "MANIFEST.json" --include "questions/*"
python tools/from-dataset.py questions --dataset fabench-data \
  --out-dir "$FABENCH_DATA_ROOT/runs/raven-bench/question-sets/july-2026-paper-287"
python tools/from-dataset.py questions --dataset fabench-data --subset sept-17-254 \
  --out-dir "$FABENCH_DATA_ROOT/runs/raven-bench/question-sets/july-2026-finance-balanced-draft3-20260917" \
  --prefix raven-july-2026
```

Each command writes the question file that the model sees and a separate grading key with the outcomes. The first writes all 287 questions of the leaderboard, which the `july-2026-paper` preset runs. The second writes the 254 questions of our own set, which the `july-2026-formal` preset runs; both presets use the same protocol. For 18 questions the dataset gives only the threshold and the Yes or No outcome, not the realized value, because the value is third-party market data. Their grading rows carry `"numeric_result_withheld": true`, and scoring uses the outcome as usual.

Keep the grading keys out of model contexts and training data.

### News archive and search index

Download the 23 files of the news archive and load them into a corpus database:

```bash
hf download raven-labs-official/fabench --repo-type dataset --local-dir fabench-data --include "corpus/july-2026-07-01/*"
python tools/corpus-from-parquet.py --out "$FABENCH_DATA_ROOT/index/ccnews-july-2026.db" \
  fabench-data/corpus/july-2026-07-01/*.parquet
```

The loader checks the hashes of every article and keeps the released article ids, so search results use the same ids as in the leaderboard runs. Then build the search index for the forecast date and try a query:

```bash
node --import tsx vendor/retrieval-infra/tools/build-frozen-index.ts \
  "$FABENCH_DATA_ROOT/index/ccnews-july-2026.db" \
  "$FABENCH_DATA_ROOT/index/frozen/ccnews-before-20260701-v1.db" 2026-07-01T00:00:00Z
pnpm run search -- --mode frozen --as-of 2026-07-01T00:00:00Z \
  --corpus "$FABENCH_DATA_ROOT/index/frozen/ccnews-before-20260701-v1.db" --query 'S&P 500 outlook' --n 5
```

The index admits only articles captured before the forecast date, so word statistics, scores and returned text all come from that period. The index builder stops if less than 12 GB of disk would remain. Both commands work in batches and continue where they stopped when you run them again with the same arguments. The index reads article text from the corpus database and refuses to run if that file changes, so leave it in place afterwards.

You can also rebuild the news archive from Common Crawl CC-NEWS with `tools/cc-news-to-jsonl.py` and `pnpm corpus:ingest`. The dataset's `DETAILS.md` lists the source files and extractor versions and explains how to check a rebuilt archive against the release. A rebuilt archive assigns its own article ids.

### Wikipedia snapshot

Frozen search also covers a fixed set of Wikipedia pages, each at its last revision before the forecast date. The dataset lists these revisions; the commands below fetch their text from Wikipedia into a local cache and check it:

```bash
hf download raven-labs-official/fabench --repo-type dataset --local-dir fabench-data --include "corpus/wiki/*"
python tools/from-dataset.py wiki-plan --dataset fabench-data --manifest july-2026-07-01-684 --out wiki-plan.json
node --import tsx vendor/retrieval-infra/tools/cache-wikipedia.ts \
  --plan wiki-plan.json --cache "$FABENCH_DATA_ROOT/index/wiki/wiki-cache.sqlite" --out wiki-receipts
python tools/from-dataset.py wiki-check --dataset fabench-data --manifest july-2026-07-01-684 \
  --built wiki-receipts/wiki-2026-07-01T00-00-00.000Z.json
mkdir -p "$FABENCH_DATA_ROOT/index/wiki/manifests"
cp wiki-receipts/wiki-2026-07-01T00-00-00.000Z.json "$FABENCH_DATA_ROOT/index/wiki/manifests/"
```

`wiki-check` confirms that every page resolved to the released revision and text. Before fetching, set `httpUserAgent` in your configuration so that Wikimedia can identify your requests. The leaderboard runs used the 684-page list. The 884-page list adds 200 pages about entities named in the questions and counts as a different experimental condition.

## 4. Run agents

Preview the experimental conditions of a run without calling the model. The model's key must be set even for the preview.

```bash
pnpm exp:forecast-value -- --preset july-2026-paper \
  --llm deepseek:deepseek-flash --settings frozen --ids J-GEO-01,J-FIN-M01 --conc 1 \
  --condition-preview-file results/preview.json
```

Remove `--condition-preview-file` to run. The command prints a summary for each question, writes a result file and the agent traces under `results/`, and records each question and condition in the experiment registry. If you run the same command again, it reuses the answers that already succeeded instead of paying for them twice. To repeat a run on purpose, add `--replicate 1 --replicate-reason "..."`.

The preset fixes the protocol, such as the tool budget, the retrieval settings and the review settings, and a run that changes one of them stops with an error. Concurrency settings are part of the condition, so keep them when you continue an earlier run. `pnpm exp:params resolve <arguments>` prints every value a run would use.

To compare result files, pass them to the leaderboard, as in [getting started](getting-started.md):

```bash
pnpm exp:leaderboard -- results/<run-a>.json results/<run-b>.json --output-dir results/my-analysis
```
