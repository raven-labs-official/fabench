#!/usr/bin/env bash
# Error-focused lint without formatting: Biome for TypeScript (biome.json) and Ruff for
# Python (ruff.toml). Files symlinked from vendor/ belong to the pinned retrieval
# dependency and are linted there: Biome does not follow symlinks, and Ruff skips them here.
# Ruff comes from requirements-dev.txt; set RUFF=/path/to/ruff if it is not on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

node_modules/.bin/biome lint

mapfile -t linked < <(find src tools question-making -type l -lname '*vendor/*' -name '*.py' | sort)
skip=()
if ((${#linked[@]})); then
  skip=(--extend-exclude "$(IFS=,; echo "${linked[*]}")")
fi
"${RUFF:-ruff}" check "${skip[@]}" .
