#!/usr/bin/env bash
# Cerebro backups: nightly dump (embeddings left out: they are rebuilt by requeue-missing-embeddings) and a full
# dump on Sundays. Runs as root on the Zima host from cerebro-backup.timer; dumps are root-only (umask 077).
#
# Exit 0: backup written, or skipped because the backup drive is not mounted (logged).
# Exit 1: refused or failed (not enough free space, dump failed) so `systemctl is-failed` / check.sh flag it.
#
# Overrides (tests, other installs):
#   CEREBRO_DB_CONTAINER  cerebro-db        CEREBRO_DB_USER cerebro      CEREBRO_DB_NAME cerebro
#   CEREBRO_BACKUP_ROOT   /DATA/Backup/cerebro
#   CEREBRO_BACKUP_MOUNT  /DATA/Backup      the mountpoint that must be mounted
#   CEREBRO_BACKUP_DATE   today (YYYY-MM-DD)  CEREBRO_BACKUP_DOW  day of week, 7 = Sunday
#   CEREBRO_KEEP_NIGHTLY  14                CEREBRO_KEEP_WEEKLY 4
set -euo pipefail
umask 077

DB_CONTAINER=${CEREBRO_DB_CONTAINER:-cerebro-db}
DB_USER=${CEREBRO_DB_USER:-cerebro}
DB_NAME=${CEREBRO_DB_NAME:-cerebro}
ROOT=${CEREBRO_BACKUP_ROOT:-/DATA/Backup/cerebro}
MOUNT=${CEREBRO_BACKUP_MOUNT:-/DATA/Backup}
DATE=${CEREBRO_BACKUP_DATE:-$(date +%F)}
DOW=${CEREBRO_BACKUP_DOW:-$(date +%u)}
KEEP_NIGHTLY=${CEREBRO_KEEP_NIGHTLY:-14}
KEEP_WEEKLY=${CEREBRO_KEEP_WEEKLY:-4}

log() { echo "cerebro-backup: $*"; }

# A directory is a mountpoint when df reports itself as the mount it lives on (portable: no mountpoint(1) on macOS).
is_mounted() {
  local m=${1%/}
  [ -n "$m" ] || m=/
  [ "$(df -P "$m" 2>/dev/null | awk 'NR==2 {print $NF}')" = "$m" ]
}

size_of() { wc -c < "$1" | tr -d ' '; }

newest_dump() { ls -1 "$1" 2>/dev/null | grep '\.dump$' | sort | tail -n 1 || true; }

# Keep the newest $2 *.dump files of directory $1.
prune() {
  local dir=$1 keep=$2 f
  [ -d "$dir" ] || return 0
  ls -1 "$dir" | grep '\.dump$' | sort -r | tail -n +"$((keep + 1))" | while read -r f; do
    rm -f -- "$dir/$f"
    log "pruned $dir/$f"
  done
}

dump() { # dump <out-file> [pg_dump args...]
  local out=$1 tmp
  shift
  tmp="$(dirname "$out")/.$(basename "$out").tmp"
  trap 'rm -f -- "$tmp"' RETURN
  if ! docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc "$@" > "$tmp"; then
    log "pg_dump failed for $out"
    return 1
  fi
  if ! docker exec -i "$DB_CONTAINER" pg_restore -l < "$tmp" > /dev/null; then
    log "dump $out is not a readable archive"
    return 1
  fi
  mv -- "$tmp" "$out"
  log "wrote $out ($(size_of "$out") bytes)"
}

if ! is_mounted "$MOUNT"; then
  log "skipped: backup drive $MOUNT is not mounted"
  exit 0
fi

mkdir -p "$ROOT/nightly"

# Never fill the drive: need twice the size of the biggest recent dump.
need=0
for d in nightly weekly; do
  f=$(newest_dump "$ROOT/$d")
  if [ -n "$f" ]; then
    s=$(size_of "$ROOT/$d/$f")
    [ "$s" -le "$need" ] || need=$s
  fi
done
need=$((need * 2))
avail=$(( $(df -Pk "$ROOT/nightly" | awk 'NR==2 {print $4}') * 1024 ))
if [ "$avail" -lt "$need" ]; then
  log "not enough free space on $ROOT: $avail bytes free, need $need (2x the last dump); not dumping"
  exit 1
fi

# summary_embeddings only exists once the summariser migration has run.
excludes=(--exclude-table-data=chunk_embeddings --exclude-table-data=embed_queue)
if [ "$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "select to_regclass('public.summary_embeddings') is not null")" = t ]; then
  excludes+=(--exclude-table-data=summary_embeddings)
fi

dump "$ROOT/nightly/$DATE.dump" "${excludes[@]}"
if [ "$DOW" = 7 ]; then
  mkdir -p "$ROOT/weekly"
  dump "$ROOT/weekly/$DATE.dump"
fi

prune "$ROOT/nightly" "$KEEP_NIGHTLY"
prune "$ROOT/weekly" "$KEEP_WEEKLY"
