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
#   CEREBRO_BACKUP_AVAIL_KB  free space to assume instead of asking df (tests)
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

# Keep the newest $2 *.dump files of directory $1.
prune() {
  local dir=$1 keep=$2 f
  [ -d "$dir" ] || return 0
  { ls -1 "$dir" | grep '\.dump$' || true; } | sort -r | tail -n +"$((keep + 1))" | while read -r f; do
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
rm -f -- "$ROOT"/nightly/.*.dump.tmp "$ROOT"/weekly/.*.dump.tmp # left behind by a killed run

# Never fill the drive: need the larger of twice the biggest existing dump and the live database's size
# (the first run, and the first Sunday's full dump, have no dump to estimate from).
need=0
for f in "$ROOT"/nightly/*.dump "$ROOT"/weekly/*.dump; do
  [ -f "$f" ] || continue
  s=$(( $(size_of "$f") * 2 ))
  [ "$s" -le "$need" ] || need=$s
done
db_size=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "select pg_database_size(current_database())")
[ "$db_size" -le "$need" ] || need=$db_size
if [ -n "${CEREBRO_BACKUP_AVAIL_KB:-}" ]; then
  avail=$(( CEREBRO_BACKUP_AVAIL_KB * 1024 ))
else
  avail=$(( $(df -Pk "$ROOT/nightly" | awk 'NR==2 {print $4}') * 1024 ))
fi
if [ "$avail" -lt "$need" ]; then
  log "not enough free space on $ROOT: $avail bytes free, need $need (max of 2x the biggest dump and the database size); not dumping"
  exit 1
fi

# summary_embeddings may not exist yet: pg_dump ignores a missing table in --exclude-table-data (tested).
excludes=(--exclude-table-data=chunk_embeddings --exclude-table-data=summary_embeddings --exclude-table-data=embed_queue)

dump "$ROOT/nightly/$DATE.dump" "${excludes[@]}"
if [ "$DOW" = 7 ]; then
  mkdir -p "$ROOT/weekly"
  dump "$ROOT/weekly/$DATE.dump"
fi

prune "$ROOT/nightly" "$KEEP_NIGHTLY"
prune "$ROOT/weekly" "$KEEP_WEEKLY"
