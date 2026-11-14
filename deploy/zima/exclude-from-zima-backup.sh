#!/usr/bin/env bash
# Owner-side, run once as root on the Zima host: stops the nightly zima-backup rsync from copying Cerebro's data
# dir /DATA/AppData/cerebro/data/ (live Postgres files, re-downloadable Ollama models, the Claude login; the dumps
# from backup.sh cover the database). The path is DATA in lib.sh.
# Mirrors the existing postgres exclude in the script: the added line is a copy of that line with the path swapped.
# Idempotent (comment lines do not count). An earlier wrong pair (cerebro/db, cerebro/ollama: those dirs never
# existed) is replaced by the data line. The result is syntax checked before it replaces the original, and the
# original is kept as <file>.bak-cerebro-<timestamp>.
#
# usage: exclude-from-zima-backup.sh [/DATA/AppData/backup/zima-backup.sh]
set -euo pipefail

file=${1:-/DATA/AppData/backup/zima-backup.sh}
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }

active() { grep -v '^[[:space:]]*#' "$file" | grep -Eq "$1"; }

want=1
stale=0
active "AppData/cerebro/data/'" && want=0
active 'AppData/cerebro/(db|ollama)/' && stale=1
if [ "$want$stale" = 00 ]; then
  echo "already excluded: $file"
  exit 0
fi
if [ "$want" = 1 ] && ! active 'AppData/postgres/data'; then
  echo "$file has no (uncommented) AppData/postgres/data exclude to mirror; add --exclude '/DATA/AppData/cerebro/data/' by hand" >&2
  exit 1
fi

tmp=$(mktemp "$file.XXXXXX")
trap 'rm -f "$tmp"' EXIT
awk -v want="$want" '
  $0 !~ /^[ \t]*#/ && /--exclude/ && /AppData\/cerebro\/(db|ollama)\// { next }
  { print }
  want == 1 && !done && $0 !~ /^[ \t]*#/ && /AppData\/postgres\/data/ {
    line = $0; sub(/AppData\/postgres\/data/, "AppData/cerebro/data", line); print line
    done = 1
  }' "$file" > "$tmp"
if ! bash -n "$tmp"; then
  echo "the edited script would not parse; $file left unchanged" >&2
  exit 1
fi
cp -p "$file" "$file.bak-cerebro-$(date +%Y%m%d-%H%M%S)"
chmod 600 "$file.bak-cerebro-"* 2>/dev/null || true
cat "$tmp" > "$file" # keep the original's owner and mode
echo "excluded /DATA/AppData/cerebro/data/ in $file"
