#!/usr/bin/env bash
# Proves the latest nightly dump restores and that embeddings can be rebuilt: restores it into a scratch database
# inside cerebro-db, compares row counts with production, runs requeue-missing-embeddings against the scratch
# database, then drops it. Run as root (dumps are root-only). Exit 1 on any mismatch.
#
# Overrides: CEREBRO_DB_CONTAINER/_USER/_NAME, CEREBRO_BACKUP_ROOT (as backup.sh);
#   CEREBRO_RESTORE_TOLERANCE_ROWS 10 and CEREBRO_RESTORE_TOLERANCE_PCT 5: allowed difference per table
#     (rows written to / removed from production since the dump);
#   CEREBRO_REQUEUE_CMD: shell command run with SCRATCH_DB exported (default: the cerebro-server container).
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

latest=$(ls -1 "$ROOT/nightly" 2>/dev/null | grep '\.dump$' | sort | tail -n 1 || true)
if [ -z "$latest" ]; then
  log "no nightly dump found in $ROOT/nightly"
  exit 1
fi
dump="$ROOT/nightly/$latest"
SCRATCH_DB="cerebro_restoretest_$$"
export SCRATCH_DB
trap 'docker exec "$DB_CONTAINER" dropdb -U "$DB_USER" --if-exists --force "$SCRATCH_DB" >/dev/null 2>&1 || true' EXIT

start=$(date +%s)
log "restoring $dump into $SCRATCH_DB"
docker exec "$DB_CONTAINER" createdb -U "$DB_USER" "$SCRATCH_DB"
docker exec -i "$DB_CONTAINER" pg_restore -U "$DB_USER" -d "$SCRATCH_DB" --exit-on-error < "$dump"
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
  base=$(docker exec "$SERVER_CONTAINER" printenv DATABASE_URL)
  out=$(docker exec -e "DATABASE_URL=${base%/*}/$SCRATCH_DB" "$SERVER_CONTAINER" bun --no-install server/src/cli.ts requeue-missing-embeddings)
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
