# Configuration

A run reads three kinds of settings, each from its own place:

| Kind | Where it is set | Examples |
| --- | --- | --- |
| API keys | Environment variables, or a `.env` file at the repository root that is never committed | `DEEPSEEK_API_KEY`, `SERPER_API_KEY` |
| Run parameters | Presets in `config/presets/`, files passed with `--config`, and command-line flags | `--llm`, `--settings`, `--n`, `--conc` |
| Installation settings | Environment variables, then a JSON file named by `FABENCH_PATHS_CONFIG`, then `config/site.json` | Data root, results directory, registry location |

Project environment variables start with `FABENCH_`. Each one is also read under its former name, with `RAVEN_` in place of `FABENCH_` (for example `RAVEN_RESULTS_DIR`), when the `FABENCH_` name is unset, so existing env files keep working; a preset or `--config` path may likewise start with the former `${RAVEN_DATA_ROOT}`. `pnpm exp:params` lists every run parameter with its type, default and environment variable, and `pnpm exp:params resolve <run arguments>` shows the value a run would use and where it came from. The rest of this page covers installation settings and API keys.

## 1. Installation settings

Each setting is read from the first of these sources that defines it: its environment variable, the JSON file named by `FABENCH_PATHS_CONFIG`, and `config/site.json`. A team that shares a server can commit its defaults to `config/site.json` (and to `vendor/retrieval-infra/configs/site.json` for the archive environment); the public repository contains neither file. Relative paths in a JSON file are resolved against that file's directory, and relative paths in environment variables against the current directory. A configuration file that cannot be read, or a key whose value is not a nonempty string, stops the run with an error.

To start, copy the example:

```bash
cp config/paths.example.json config/paths.local.json   # ignored by Git
export FABENCH_PATHS_CONFIG="$PWD/config/paths.local.json"
```

| Key | Environment variable | Used for | When unset |
| --- | --- | --- | --- |
| `dataRoot` | `FABENCH_DATA_ROOT` | Paths written as `${FABENCH_DATA_ROOT}/...` in presets and `--config` files: indexes, question sets and caches | These paths point below `/dev/null/FABENCH_DATA_ROOT-not-set`, so a run that needs them fails with a message naming the variable |
| `resultsDir` | `FABENCH_RESULTS_DIR` | Run results, traces and retrieved evidence | `<repo>/results` |
| `registryPath` | `FABENCH_EXPERIMENT_REGISTRY` | The experiment registry (SQLite) that records each question and condition | The shared registry if `<sharedRoot>/runs` exists, otherwise `<resultsDir>/experiment-registry.sqlite` |
| `sharedRoot` | `FABENCH_SHARED_ROOT` | Root of the optional layout for teams that share a server (section 2) | Shared features are off |
| `siteName` | `FABENCH_SITE_NAME` | Server name in progress messages | The host name |
| `teamGroup` | `FABENCH_TEAM_GROUP` | Unix group for files that the shared-server scripts create | Needed only by those scripts |
| `reportHost` | `FABENCH_REPORT_HOST` | SSH host that the leaderboard tools query when no local registry is given | The tools ask for `--local`, `--registry` or `--host` |
| `httpUserAgent` | `FABENCH_HTTP_USER_AGENT` | User-Agent for requests to Wikipedia and web archives; add contact details if a source asks for them | `FABench/0.1 (research)` |
| `envAliases` | none | Former names of renamed environment variables, for example `{"GLM_API_KEY": ["OLD_GLM_KEY"]}`; a former name is read only when the current one is unset | None |

A minimal `paths.local.json` for one machine:

```json
{
  "dataRoot": "/srv/fabench-data",
  "resultsDir": "../results"
}
```

## 2. Teams that share a server

Setting `sharedRoot` turns on the layout we use when several people run experiments on one server. Below that root live a central experiment registry (`runs/raven-bench/registry.sqlite`), the results of shared runs, API rate limits shared across processes, shared env files under `config/raven-bench/` and a shared cache of frozen search queries. When `current/raven-bench` exists below the root, runs must go through the shared launcher, whose scripts are not part of this repository. Without `sharedRoot`, these paths point below `/dev/null/FABENCH_SHARED_ROOT-not-set`, where nothing can be created, and a checkout used by one person keeps everything in its own `results/` directory.

## 3. Data root and the July 2026 preset

`july-2026-formal` is the default preset, set in `config/default-preset.json`, so runs without `--preset` use it. `july-2026-paper` uses the same protocol on all 287 questions of the leaderboard. Both expect their files below `${FABENCH_DATA_ROOT}`:

```text
${FABENCH_DATA_ROOT}/
  runs/raven-bench/question-sets/july-2026-finance-balanced-draft3-20260917/   # july-2026-formal
    raven-july-2026-model-test.jsonl
    raven-july-2026-grading-key.jsonl
  runs/raven-bench/question-sets/july-2026-paper-287/                          # july-2026-paper
    raven-july-all-model-test.jsonl
    raven-july-all-grading-key.jsonl
  index/frozen/ccnews-before-20260701-v1.db           # search index for the forecast date 2026-07-01
  index/ccnews-july-2026.db                           # corpus database that the index reads
  index/wiki/manifests/wiki-2026-07-01T00-00-00.000Z.json
  index/wiki/wiki-cache.sqlite                        # Wikipedia revision cache
  cache/frozen-query/cache.sqlite                     # created on first use
  runs/raven-bench/review-cache-shared/               # cache of web page reviews, created on first use
```

[Reproduction, section 3](reproduction.md#3-prepare-the-july-2026-data) fills this layout from the dataset. `${FABENCH_DATA_ROOT}` is expanded only at the start of a path in a preset or `--config` file. To keep a file elsewhere, set its key in a `--config` file; `pnpm exp:params` lists the key names.

## 4. API keys and other environment variables

Set only the keys that your models and settings use; `.env.example` lists the common ones.

| Variable | Needed for |
| --- | --- |
| `DEEPSEEK_API_KEY`, optionally `DEEPSEEK_BASE_URL` | DeepSeek models, and the default review model of the web settings |
| `KIMI_API_KEY`, `GLM_API_KEY` (with `GLM_BASE_URL`), `BAILIAN_API_KEY`, `FABENCH_OPENROUTER_API_KEY`, `CUSTOM_API_KEY` with `CUSTOM_BASE_URL` | The corresponding `--llm` providers |
| `SERPER_API_KEY` | Web search in `web-filter` and `both` |
| `JINA_API_KEY` | Page reading in `web-filter` and `both` |
| `FABENCH_CORPUS_DB` | Search index used when `--frozen-corpus-file` is not given |
| `HTMLDATE_PYTHON` | Python interpreter with the archive environment's requirements, used for page dating and extraction |
| `PLAYWRIGHT_BROWSERS_PATH` | Location of the optional browser fallback |
| `FABENCH_TEAM_ENV_FILE` | An env file to read keys from instead of `.env` |

A key is read from the process environment first. If it is not set there, it comes from the first of these files that exists: `FABENCH_TEAM_ENV_FILE`, the shared team file `<sharedRoot>/config/raven-bench/team.env`, and `.env` in the current directory. Run commands from the repository root so that `.env` is found. Keys are never written to results, traces or configuration files.
