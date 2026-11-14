#!/usr/bin/env bash
# Owner-side, run once as root on the Zima host: stops the nightly zima-backup rsync from copying Cerebro's live
# Postgres files and re-downloadable Ollama models (the dumps from backup.sh cover the database).
# Mirrors the existing postgres exclude in the script: each new line is a copy of that line with the path swapped.
# Idempotent; keeps a one-time copy of the original as <file>.bak-cerebro.
#
# usage: exclude-from-zima-backup.sh [/DATA/AppData/backup/zima-backup.sh]
set -euo pipefail

file=${1:-/DATA/AppData/backup/zima-backup.sh}
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }

if grep -q 'AppData/cerebro/db' "$file" && grep -q 'AppData/cerebro/ollama' "$file"; then
  echo "already excluded: $file"
  exit 0
fi
if ! grep -q 'AppData/postgres/data' "$file"; then
  echo "$file has no AppData/postgres/data exclude to mirror; add the two excludes by hand" >&2
  exit 1
fi

[ -e "$file.bak-cerebro" ] || cp -p "$file" "$file.bak-cerebro"
tmp=$(mktemp "$file.XXXXXX")
trap 'rm -f "$tmp"' EXIT
awk '
  { print }
  !done && /AppData\/postgres\/data/ {
    for (i = 0; i < 2; i++) {
      line = $0
      sub(/AppData\/postgres\/data/, i == 0 ? "AppData/cerebro/db" : "AppData/cerebro/ollama", line)
      print line
    }
    done = 1
  }' "$file" > "$tmp"
cat "$tmp" > "$file" # keep the original's owner and mode
bash -n "$file"
echo "added the cerebro excludes to $file"
