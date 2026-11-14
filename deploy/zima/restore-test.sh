#!/usr/bin/env bash
# Proves the latest nightly dump restores and that embeddings can be rebuilt: restores it into a scratch database
# inside cerebro-db, compares row counts with production, runs requeue-missing-embeddings against the scratch
# database, then drops it. Run as root (dumps are root-only). Exit 1 on any mismatch.
#
# Overrides: CEREBRO_DB_CONTAINER/_USER/_NAME, CEREBRO_BACKUP_ROOT (as backup.sh);
#   CEREBRO_RESTORE_TOLERANCE_ROWS 10 and CEREBRO_RESTORE_TOLERANCE_PCT 5: allowed difference per table
#     (rows written to / removed from production since the dump);
#   CEREBRO_REQUEUE_CMD: shell command run with SCRATCH_DB exported (default: the cerebro-server container);
#   CEREBRO_SCRATCH_DB: scratch database name (tests; must differ from the production database).
set -euo pipefail
umask 077

DB_CONTAINER=${CEREBRO_DB_CONTAINER:-cerebro-db}
DB_USER=${CEREBRO_DB_USER:-cerebro}
DB_NAME=${CEREBRO_DB_NAME:-cerebro}
ROOT=${CEREBRO_BACKUP_ROOT:-/DATA/Backup/cerebro}
TOL_ROWS=${CEREBRO_RESTORE_TOLERANCE_ROWS:-10}
TOL_PCT=${CEREBRO_RESTORE_TOLERANCE_PCT:-5}
SERVER_CONTAINER=${CEREBRO_SERVER_CONTAINER:-cerebro-server}

log() { echo "restore-test: $*"; }
psql_in() { docker exec "$DB_CONTAINER" psql -U "$DB_USER" -v ON_ERROR_STOP=1 -tA -d "$1" -c "$2"; }

dump=""
for f in "$ROOT"/nightly/*.dump; do # names are dates: the glob's order is oldest first
  if [ -f "$f" ]; then dump=$f; fi
done
if [ -z "$dump" ]; then
  log "no nightly dump found in $ROOT/nightly"
  exit 1
fi
SCRATCH_DB=${CEREBRO_SCRATCH_DB:-cerebro_restoretest_$(date +%s)_$$}
export SCRATCH_DB
if [ "$SCRATCH_DB" = "$DB_NAME" ]; then
  log "refusing: scratch database name equals the production database ($DB_NAME)"
  exit 1
fi

# Sweep scratch databases a killed earlier run left behind (name carries its start time).
now=$(date +%s)
for old in $(psql_in postgres "select datname from pg_database where datname ~ '^cerebro_restoretest_[0-9]+_[0-9]+\$'"); do
  stamp=${old#cerebro_restoretest_}
  stamp=${stamp%%_*}
  if [ $((now - stamp)) -gt 86400 ]; then
    log "dropping leftover scratch database $old"
    docker exec "$DB_CONTAINER" dropdb -U "$DB_USER" --if-exists --force "$old" || log "could not drop leftover $old"
  fi
done

cleanup() {
  docker exec "$DB_CONTAINER" dropdb -U "$DB_USER" --if-exists --force "$SCRATCH_DB" >/dev/null || log "could not drop scratch database $SCRATCH_DB"
}
trap cleanup EXIT

start=$(date +%s)
log "restoring $dump into $SCRATCH_DB"
docker exec "$DB_CONTAINER" createdb -U "$DB_USER" "$SCRATCH_DB"
# Inside production's 2 GB container: index builds get a small, serial maintenance budget (the conf allows 256 MB x 3).
docker exec -i -e PGOPTIONS='-c maintenance_work_mem=64MB -c max_parallel_maintenance_workers=0' "$DB_CONTAINER" \
  pg_restore -U "$DB_USER" -d "$SCRATCH_DB" --exit-on-error < "$dump"
log "restored in $(( $(date +%s) - start ))s"

tables=(clients projects bindings sessions events chunks)
if [ "$(psql_in "$DB_NAME" "select to_regclass('public.summaries') is not null")" = t ]; then
  tables+=(summaries)
fi
fail=0
for t in "${tables[@]}"; do
  prod=$(psql_in "$DB_NAME" "select count(*) from $t")
  restored=$(psql_in "$SCRATCH_DB" "select count(*) from $t")
  diff=$((prod > restored ? prod - restored : restored - prod))
  allowed=$((TOL_ROWS + prod * TOL_PCT / 100))
  if [ "$diff" -gt "$allowed" ]; then
    log "$t differ: production $prod, restored $restored (allowed difference $allowed)"
    fail=1
  else
    log "$t: production $prod, restored $restored"
  fi
done
[ "$fail" = 0 ] || exit 1

# Embeddings are not in nightlies: prove they can be rebuilt.
if [ -n "${CEREBRO_REQUEUE_CMD:-}" ]; then
  out=$(bash -c "$CEREBRO_REQUEUE_CMD")
else
  # The URL carries the password: rewrite it inside the container so it never appears in host process args.
  out=$(docker exec "$SERVER_CONTAINER" sh -c 'DATABASE_URL="${DATABASE_URL%/*}/$1" exec bun --no-install server/src/cli.ts requeue-missing-embeddings' _ "$SCRATCH_DB")
fi
echo "$out"
chunks=$(psql_in "$SCRATCH_DB" "select count(*) from chunks")
missing=$(psql_in "$SCRATCH_DB" "select count(*) from chunks c where not exists (select 1 from chunk_embeddings e where e.chunk_id = c.id)")
queued=$(psql_in "$SCRATCH_DB" "select count(*) from embed_queue")
if [ "$queued" != "$missing" ]; then
  log "requeue queued $queued chunk(s) but $missing of $chunks have no vector"
  exit 1
fi
log "restore test passed: $chunks chunks restored, $queued queued for re-embedding, total $(( $(date +%s) - start ))s"
