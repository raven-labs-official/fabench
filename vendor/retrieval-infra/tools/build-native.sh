#!/usr/bin/env bash
# Builds the optional SQLite extension native/raven_bm25.c into native/build/raven_bm25.so.
# The headers are SQLite 3.51.3's, the version Node 22 bundles. Without the build, frozen
# search uses FTS5's built-in bm25(), which ranks identically but more slowly.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
mkdir -p "$root/native/build"
cc -O2 -Wall -Wextra -fPIC -shared -I"$root/native/sqlite-3.51.3" \
  "$root/native/raven_bm25.c" -o "$root/native/build/raven_bm25.so" -lm
echo "built $root/native/build/raven_bm25.so"
