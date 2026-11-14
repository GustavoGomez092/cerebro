#!/usr/bin/env bash
# Cerebro backups: nightly dump (embeddings left out: they are rebuilt by requeue-missing-embeddings) and a full
# dump on Sundays. Runs as root on the Zima host from cerebro-backup.timer; dumps are root-only (umask 077).
#
# Exit 0: backup written, or skipped because the backup drive is not mounted (logged).
# Exit 1: refused or failed (not enough free space, database not ready, dump failed) so `systemctl is-failed` /
#   check.sh flag it.
#
# The backup drive is shared (zima-backup snapshots, postgres-backup): a run only dumps when the dumps it is about to
# write still leave CEREBRO_BACKUP_RESERVE_GB free. Each dump is estimated from the newest dump of the same kind
# (nightly / weekly), or the live database's size when there is none yet.
#
# Overrides (tests, other installs):
#   CEREBRO_DB_CONTAINER  cerebro-db        CEREBRO_DB_USER cerebro      CEREBRO_DB_NAME cerebro
#   CEREBRO_BACKUP_ROOT   /DATA/Backup/cerebro
#   CEREBRO_BACKUP_MOUNT  /DATA/Backup      the mountpoint that must be mounted
#   CEREBRO_BACKUP_DATE   today (YYYY-MM-DD)  CEREBRO_BACKUP_DOW  day of week, 7 = Sunday
#   CEREBRO_KEEP_NIGHTLY  14                CEREBRO_KEEP_WEEKLY 4
#   CEREBRO_BACKUP_RESERVE_GB 20         free space the backup drive keeps after this run's dumps
#   CEREBRO_BACKUP_DB_WAIT   120         seconds to wait for the database to accept connections (boot, power loss)
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
RESERVE_GB=${CEREBRO_BACKUP_RESERVE_GB:-20}
DB_WAIT=${CEREBRO_BACKUP_DB_WAIT:-120}

log() { echo "cerebro-backup: $*"; }

# A directory is a mountpoint when df reports itself as the mount it lives on (portable: no mountpoint(1) on macOS).
is_mounted() {
  local m=${1%/}
  [ -n "$m" ] || m=/
  [ "$(df -P "$m" 2>/dev/null | awk 'NR==2 {print $NF}')" = "$m" ]
}

size_of() { wc -c < "$1" | tr -d ' '; }

# The *.dump files of directory $1, oldest first (names are dates). Prints nothing for a missing or empty dir.
dumps_in() {
  local f
  for f in "$1"/*.dump; do
    if [ -f "$f" ]; then printf '%s\n' "$f"; fi
  done | sort
}

# Keep the newest $2 *.dump files of directory $1.
prune() {
  local dir=$1 keep=$2 f
  dumps_in "$dir" | sort -r | tail -n +"$((keep + 1))" | while read -r f; do
    rm -f -- "$f"
    log "pruned $f"
  done
}

# Bytes the next dump into directory $1 will take: the newest dump there, else the database's size.
estimate() {
  local last
  last=$(dumps_in "$1" | tail -n 1)
  if [ -n "$last" ]; then size_of "$last"; else printf '%s\n' "$db_size"; fi
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

# The timer is Persistent: after a power loss it fires at boot, while Docker may still be starting the database.
deadline=$((SECONDS + DB_WAIT))
until docker exec "$DB_CONTAINER" pg_isready -q -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    log "database not ready after $DB_WAIT s ($DB_CONTAINER); not dumping"
    exit 1
  fi
  [ -n "${waited:-}" ] || log "waiting for the database ($DB_CONTAINER) to accept connections"
  waited=1
  sleep 2
done

# Never eat into the reserve of the shared drive: this run's dumps (nightly, plus the full dump on Sundays) are
# estimated from the newest dump of the same kind, or the database's size when there is none yet.
db_size=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "select pg_database_size(current_database())")
need=$(estimate "$ROOT/nightly")
if [ "$DOW" = 7 ]; then need=$((need + $(estimate "$ROOT/weekly"))); fi
reserve=$((RESERVE_GB * 1024 * 1024 * 1024))
if [ -n "${CEREBRO_BACKUP_AVAIL_KB:-}" ]; then
  avail=$(( CEREBRO_BACKUP_AVAIL_KB * 1024 ))
else
  avail=$(( $(df -Pk "$ROOT/nightly" | awk 'NR==2 {print $4}') * 1024 ))
fi
if [ "$avail" -lt $((need + reserve)) ]; then
  log "not enough free space on $ROOT: $avail bytes free, this run needs ~$need plus the $RESERVE_GB GB reserve kept for the shared drive; not dumping"
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
