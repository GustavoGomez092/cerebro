#!/usr/bin/env bash
# Owner-side, run once as root on the Zima host: stops the nightly zima-backup rsync from copying Cerebro's live
# Postgres files and re-downloadable Ollama models (the dumps from backup.sh cover the database).
# Mirrors the existing postgres exclude in the script: each missing line is a copy of that line with the path swapped.
# Idempotent (comment lines do not count, a half-applied state only gets the missing line). The result is syntax
# checked before it replaces the original, and the original is kept as <file>.bak-cerebro-<timestamp>.
#
# usage: exclude-from-zima-backup.sh [/DATA/AppData/backup/zima-backup.sh]
set -euo pipefail

file=${1:-/DATA/AppData/backup/zima-backup.sh}
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }

active() { grep -v '^[[:space:]]*#' "$file" | grep -q "$1"; }

want_db=1
want_ollama=1
active 'AppData/cerebro/db' && want_db=0
active 'AppData/cerebro/ollama' && want_ollama=0
if [ "$want_db$want_ollama" = 00 ]; then
  echo "already excluded: $file"
  exit 0
fi
if ! active 'AppData/postgres/data'; then
  echo "$file has no (uncommented) AppData/postgres/data exclude to mirror; add the two excludes by hand" >&2
  exit 1
fi

tmp=$(mktemp "$file.XXXXXX")
trap 'rm -f "$tmp"' EXIT
awk -v want_db="$want_db" -v want_ollama="$want_ollama" '
  { print }
  !done && $0 !~ /^[ \t]*#/ && /AppData\/postgres\/data/ {
    if (want_db == 1) { line = $0; sub(/AppData\/postgres\/data/, "AppData/cerebro/db", line); print line }
    if (want_ollama == 1) { line = $0; sub(/AppData\/postgres\/data/, "AppData/cerebro/ollama", line); print line }
    done = 1
  }' "$file" > "$tmp"
if ! bash -n "$tmp"; then
  echo "the edited script would not parse; $file left unchanged" >&2
  exit 1
fi
cp -p "$file" "$file.bak-cerebro-$(date +%Y%m%d-%H%M%S)"
cat "$tmp" > "$file" # keep the original's owner and mode
echo "added the cerebro excludes to $file"
