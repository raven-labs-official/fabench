# Getting started

This page checks that the scoring code works on your machine and shows how to score your own runs. It uses two small synthetic result files, so it needs no model, API key or data download.

## Run the example

From the repository root, with Node 22 and pnpm 11:

```bash
pnpm install --frozen-lockfile
pnpm example:analysis
```

The example reads the two result files in [examples/analysis](../examples/analysis/). Both answer the same four invented questions in the `none` setting. The command prints a leaderboard and writes it to `results/example-analysis/leaderboard.json`, with one row per file:

| File | Probabilities | Outcomes | Brier | Brier Index |
| --- | --- | --- | ---: | ---: |
| example-a | 0.8, 0.2, 0.7, 0.4 | 1, 0, 1, 0 | 0.0825 | 71.28 |
| example-b | 0.5 for all four | 1, 0, 1, 0 | 0.25 | 50.00 |

The Brier score is the mean squared difference between the probability and the outcome, so lower is better. The Brier Index is 100 × (1 − √Brier), so higher is better. With only four questions, the bootstrap intervals in the output only show the format.

## Score your own runs

Every run of `pnpm exp:forecast-value` writes a result file under `results/`. To compare two runs, pass their result files to the leaderboard:

```bash
pnpm exp:leaderboard -- \
  results/forecast-value-run-a.json results/forecast-value-run-b.json \
  --output-dir results/my-analysis
```

The leaderboard scores each setting separately and uses only the questions that appear in every file with the same outcome.

To score an agent that you run outside this repository, write its answers in the format of the two example files. Each file names the model in `config.llm` and lists the questions in `perQuestion`, one entry per question with its `question_id`, its `outcome` and a `forecasts` object that maps each setting to a probability. Then pass the files to the same command.

## Next steps

[Reproduction](reproduction.md) shows how to prepare the data and rerun the leaderboard runs. [Configuration](configuration.md) describes the paths and API keys a run reads.
