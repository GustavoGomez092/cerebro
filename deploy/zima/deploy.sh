#!/usr/bin/env bash
# Deploy Cerebro to the ZimaOS box: deploy/zima/deploy.sh [--first-run]
#
# clean tree + `bun test` → server-side deploy lock → first run: secrets (root 700/600, generated on the
# server, never printed) and data dirs → rsync the repo to /DATA/AppData/cerebro/src → build
# cerebro-server:<sha7> → bge-m3 present with the digest pinned in deploy/.env → db + ollama up → pre-deploy
# dump when the migration list changed → migrate in a one-off container → keep the running image as :prev →
# start the new server → health gate (/health ok + db within 60 s); a failed start, failed gate or an
# interrupt rolls back to :prev and exits 1 → check token, ZimaOS registration, old image cleanup.
#
# Rollback runs :prev on the schema the new release migrated, so migrations must stay backward-compatible
# (expand/contract; see README "Deploying to the Zima server").
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deploy/zima/lib.sh
source "$HERE/lib.sh"
cd "$(git -C "$HERE" rev-parse --show-toplevel)"

FIRST_RUN=0
case "${1-}" in
  --first-run) FIRST_RUN=1 ;;
  "") ;;
  *) die "usage: deploy/zima/deploy.sh [--first-run]" ;;
esac

for tool in git rsync jq awk; do command -v "$tool" >/dev/null || die "needs $tool"; done
ENV_FILE=deploy/.env
[[ -f $ENV_FILE ]] || die "missing deploy/.env (copy deploy/.env.example and set BGE_M3_DIGEST)"
BGE_M3_DIGEST=$(env_get BGE_M3_DIGEST "$ENV_FILE")
BGE_M3_DIGEST=${BGE_M3_DIGEST#sha256:}
[[ ${#BGE_M3_DIGEST} -ge 12 ]] || die "set BGE_M3_DIGEST in deploy/.env (bge-m3's Ollama digest, at least 12 hex chars)"
OLLAMA_CPUS=$(env_get OLLAMA_CPUS "$ENV_FILE")
OLLAMA_CPUS=${OLLAMA_CPUS:-4}
OLLAMA_IMAGE=$(sed -n 's/^ *image: *\(ollama\/ollama[^ ]*\) *$/\1/p' deploy/compose.yml)
[[ -n $OLLAMA_IMAGE ]] || die "no ollama/ollama image in deploy/compose.yml"
HEALTH_TIMEOUT=${CEREBRO_HEALTH_TIMEOUT:-60}

[[ -z $(git status --porcelain) ]] || die "working tree is dirty; commit first (the image tag is the commit)"
bun test || die "bun test failed; not deploying"

SHA=$(git rev-parse --short=7 HEAD)
IMAGE=cerebro-server:$SHA
NEXT=$APP/docker-compose.next.yml # the release being deployed; becomes $COMPOSE once healthy
LOCK=$STATE/deploy.lock
MIGRATIONS=$(git ls-files -- server/migrations | sed 's|.*/||' | sort)
DUMP=""     # pre-deploy dump taken by this run
MIGRATED="" # migrations this release applied

# deploy/compose.yml with its variables resolved and absolute paths, so ZimaOS can run its stored copy as is.
render_compose() {
  # Patterns live in variables: bash 3.2 (macOS) splits ${c//pat/rep} at a '/' even inside quotes.
  local c tag=$1 conf=$SRC/deploy/postgres.conf:
  # shellcheck disable=SC2016 # literal compose variables, not expansions
  local v_data='${CEREBRO_DATA}' v_secrets='${CEREBRO_SECRETS}' v_tag='${CEREBRO_TAG}' v_cpus='${OLLAMA_CPUS:-4}' rel='./postgres.conf:'
  c=$(cat deploy/compose.yml)
  c=${c//"$v_data"/$DATA}
  c=${c//"$v_secrets"/$SECRETS}
  c=${c//"$v_tag"/$tag}
  c=${c//"$v_cpus"/$OLLAMA_CPUS}
  c=${c//"$rel"/$conf}
  # shellcheck disable=SC2016
  [[ $c != *'${'* ]] || die "deploy/compose.yml uses a variable render_compose does not resolve"
  printf '%s\n' "$c"
}

# The x-casaos block (dashboard tile metadata) of a compose file on stdin.
casaos_meta() { awk '/^x-casaos:/ { on = 1; print; next } on && /^[^[:space:]#]/ { on = 0 } on'; }

# Polls /health until the deadline; on {ok: true, db: true} prints the instanceId and succeeds.
health_gate() {
  local body deadline=$((SECONDS + HEALTH_TIMEOUT))
  while :; do
    body=$(zssh "curl -s -m 2 http://127.0.0.1:8790/health" || true)
    if [[ -n $body ]] && jq -e '.ok == true and .db == true' >/dev/null 2>&1 <<<"$body"; then
      jq -r '.instanceId // empty' <<<"$body"
      return 0
    fi
    ((SECONDS < deadline)) || return 1
    sleep 2
  done
}

# Puts :prev back after the new server failed to start, failed the gate or was interrupted; always exits 1.
rollback() {
  trap - INT TERM
  local msg="$IMAGE $1" logs="ssh zima sudo docker logs --tail 50 cerebro-server"
  if [[ -n $MIGRATED ]]; then
    msg="$msg; it applied migrations ($MIGRATED), so :prev runs on the migrated schema; pre-deploy dump: ${DUMP:-none taken} (not restored automatically)"
  fi
  zssh "sudo rm -f $NEXT" || true
  zssh "sudo docker image inspect cerebro-server:prev >/dev/null 2>&1" ||
    die "$msg; there is no cerebro-server:prev to roll back to; see: $logs"
  render_compose prev | zssh "sudo tee $COMPOSE >/dev/null" || die "$msg; could not write the rollback compose"
  zssh "sudo docker compose -f $COMPOSE up -d --no-deps server" ||
    die "$msg; starting cerebro-server:prev failed too; see: $logs"
  if health_gate >/dev/null; then die "$msg; rolled back to cerebro-server:prev (healthy)"; fi
  die "$msg; rolled back to cerebro-server:prev, which is NOT healthy either; see: $logs"
}

LOCKED=0
release_lock() { if ((LOCKED)); then zssh "sudo rm -rf $LOCK" || true; fi; }

# --- Functions below run on the server as root (via zfn). ---

# Creates the secrets once (kept on later runs) and the data dirs.
first_run_setup() {
  local secrets=$1 data=$2 pw
  # Data dirs first, with the default umask, so the app dir stays traversable (src/ is synced as the ssh user).
  umask 022
  mkdir -p "$data/db" "$data/ollama" "$data/claude"
  chown 999:999 "$data/db"         # postgres in the pgvector image
  chown 10010:10010 "$data/claude" # cerebro user in the server image (Claude login)
  umask 077
  mkdir -p "$secrets"
  chmod 700 "$secrets"
  chown root:root "$secrets"
  if [[ -s $secrets/db.env ]]; then
    pw=$(secret_read "$secrets/db.env" POSTGRES_PASSWORD)
    echo "secrets: keeping the existing database password"
  else
    pw=$(secret_new)
    printf 'POSTGRES_PASSWORD=%s\n' "$pw" | secret_write "$secrets/db.env"
    echo "secrets: generated the database password (not shown)"
  fi
  [[ -n $pw ]] || { echo "secrets: db.env has no POSTGRES_PASSWORD" >&2; return 1; }
  if [[ ! -s $secrets/server.env ]]; then
    printf '%s\n' "DATABASE_URL=postgres://cerebro:$pw@cerebro-db:5432/cerebro" SUMMARY_SHARE=0.2 \
      SUBSCRIPTION_TOKENS_PER_5H=2000000 SUMMARISER_ENABLED=true | secret_write "$secrets/server.env"
    echo "secrets: wrote server.env"
  fi
  chown root:root "$secrets/db.env" "$secrets/server.env"
}

# Dumps the database (embeddings excluded, like the nightlies) to DIR/SHA.dump, root 600; keeps the newest 3.
pre_deploy_dump() {
  local dir=$1 sha=$2 tmp
  umask 077
  mkdir -p "$dir"
  chmod 700 "$dir"
  tmp=$(mktemp "$dir/.partial.XXXXXX")
  if ! docker exec cerebro-db pg_dump -U cerebro -d cerebro -Fc --exclude-table-data=chunk_embeddings \
    --exclude-table-data=summary_embeddings --exclude-table-data=embed_queue >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$dir/$sha.dump"
  # shellcheck disable=SC2012 # plain file names written by this function
  ls -1t "$dir"/*.dump | tail -n +4 | while read -r old; do rm -f "$old"; done
}

# Creates the `check` machine token for check.sh in FILE (root 600). The token is never printed.
create_check_token() {
  local out tok
  out=$(docker exec cerebro-server bun --no-install server/src/cli.ts token create check)
  tok=$(printf '%s\n' "$out" | grep '^cbr_' | head -n 1)
  [[ -n $tok ]] || { echo "check token: no token in the output of token create" >&2; return 1; }
  umask 077
  printf '%s\n' "$tok" | secret_write "$1"
  chown root:root "$1"
  echo "created the check machine token in $1 (not shown)"
}

# --- Deploy ---

say "deploying $IMAGE to $ZIMA_HOST"
# One deploy at a time (the owner has several Macs): an atomic mkdir on the server, before any change.
if ! zssh "sudo mkdir -p $STATE && sudo mkdir $LOCK 2>/dev/null"; then
  held=$(zssh "sudo cat $LOCK/owner 2>/dev/null" || true)
  die "another deploy holds $LOCK (${held:-owner unknown}); if it is stale: ssh zima sudo rm -rf $LOCK"
fi
LOCKED=1
trap release_lock EXIT
trap 'die "interrupted; the running server is unchanged"' INT TERM
printf '%s from %s at %s\n' "$SHA" "$(hostname -s 2>/dev/null || hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" |
  zssh "sudo tee $LOCK/owner >/dev/null"

if ((FIRST_RUN)); then
  zfn first_run_setup "$SECRETS" "$DATA"
else
  zssh "sudo test -s $SECRETS/db.env && sudo test -s $SECRETS/server.env" ||
    die "no secrets on the server; run deploy/zima/deploy.sh --first-run"
fi

zssh "sudo mkdir -p $SRC && sudo chown -R \$(id -un) $SRC"
rsync -az --delete --exclude=.git --exclude=.claude --exclude=.superpowers --exclude-from=.gitignore \
  -e "ssh ${ZSSH_OPTS[*]}" ./ "$ZIMA_HOST:$SRC/"

say "building $IMAGE on the server"
zssh "sudo docker build -t $IMAGE -f $SRC/server/Dockerfile $SRC" || die "build failed; nothing changed"

# cerebro-net is internal (no internet), so the model is pulled by a one-off container on the default network
# into the same models dir; the digest check also catches a model that changed upstream.
if ! zssh "sudo test -f $BGE_MANIFEST"; then
  say "pulling bge-m3"
  zssh "sudo docker run --rm --name cerebro-ollama-pull -v $DATA/ollama:/root/.ollama --entrypoint /bin/sh $OLLAMA_IMAGE \
    -c 'ollama serve >/dev/null 2>&1 & for _ in \$(seq 1 30); do ollama list >/dev/null 2>&1 && break; sleep 1; done; ollama pull bge-m3'"
fi
digest=$(zssh "sudo sha256sum $BGE_MANIFEST" | cut -d' ' -f1) || die "bge-m3 is missing from $DATA/ollama"
[[ $digest == "$BGE_M3_DIGEST"* ]] ||
  die "bge-m3 digest ${digest:0:12} does not match BGE_M3_DIGEST ${BGE_M3_DIGEST:0:12} in deploy/.env; the running server is unchanged"

render_compose "$SHA" | zssh "sudo tee $NEXT >/dev/null"
zssh "sudo docker compose -f $NEXT up -d --wait db ollama"

# A recovery point before the schema changes: rollback brings back the old code, not the old schema.
recorded=$(zssh "sudo cat $STATE/migrations 2>/dev/null" || true)
if [[ $MIGRATIONS != "$recorded" ]]; then
  DUMP=$STATE/pre-deploy/$SHA.dump
  say "the migration list changed; taking a pre-deploy dump"
  zfn pre_deploy_dump "$STATE/pre-deploy" "$SHA" || die "pre-deploy dump failed; not migrating (the running server is unchanged)"
fi
say "migrating"
mig_out=$(zssh "sudo docker compose -f $NEXT run --rm --no-deps server bun server/src/cli.ts migrate") || {
  printf '%s\n' "$mig_out"
  die "migration failed; the running server is unchanged${DUMP:+ (pre-deploy dump: $DUMP)}"
}
printf '%s\n' "$mig_out"
MIGRATED=$(sed -n 's/^migrated: //p' <<<"$mig_out")

running=$(zssh "sudo docker inspect -f '{{.Config.Image}}' cerebro-server 2>/dev/null" || true)
if [[ -n $running && $running != "$IMAGE" ]]; then
  zssh "sudo docker tag $running cerebro-server:prev"
  say "kept $running as cerebro-server:prev"
fi

say "starting $IMAGE"
trap 'rollback "was interrupted while starting"' INT TERM
zssh "sudo docker compose -f $NEXT up -d --no-deps server" || rollback "failed to start"
instance=$(health_gate) || rollback "failed the health gate"
trap 'die "interrupted after $IMAGE went live; re-run the deploy to finish registration"' INT TERM

zssh "sudo mv $NEXT $COMPOSE"
printf '%s\n' "$instance" | zssh "sudo tee $STATE/instance-id >/dev/null"
printf '%s\n' "$MIGRATIONS" | zssh "sudo tee $STATE/migrations >/dev/null"
printf '%s %s\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | zssh "sudo tee $STATE/deployed >/dev/null"

if ! zssh "sudo test -s $SECRETS/check.token"; then
  zfn create_check_token "$SECRETS/check.token" ||
    say "warning: could not create the check machine token; check.sh needs $SECRETS/check.token"
fi

# ZimaOS reads the dashboard tile from its stored compose. A new app is registered with `install`; for an
# installed (uncontrolled) app, `apply` doesn't refresh the stored copy, so copy it over and restart app
# management only when the tile metadata changed (no container recreate).
if zssh "sudo test -f $CASA_COMPOSE"; then
  old_meta=$(zssh "sudo cat $CASA_COMPOSE" | casaos_meta)
  new_meta=$(render_compose "$SHA" | casaos_meta)
  zssh "sudo cp $CASA_COMPOSE $APP/casaos-compose.bak.yml && sudo cp $COMPOSE $CASA_COMPOSE"
  if [[ $old_meta != "$new_meta" ]]; then
    zssh "sudo systemctl restart zimaos-app-management"
    say "dashboard metadata changed; restarted zimaos-app-management"
  fi
else
  zssh "sudo casaos-cli app-management install -f $COMPOSE"
  say "registered the ZimaOS app"
fi

# Old server images: keep this release, :prev and whatever ZimaOS's stored compose references.
stored_tag=$(zssh "sudo cat $CASA_COMPOSE 2>/dev/null" | sed -n 's/^ *image: *\(cerebro-server:[^ ]*\).*$/\1/p' | head -n 1 || true)
stale=""
for t in $(zssh "sudo docker images cerebro-server --format '{{.Repository}}:{{.Tag}}'" || true); do
  case $t in
    "$IMAGE" | cerebro-server:prev | "$stored_tag" | *"<none>") ;;
    *) stale="$stale $t" ;;
  esac
done
if [[ -n $stale ]]; then zssh "sudo docker rmi$stale" || say "warning: could not untag$stale"; fi
zssh "sudo docker builder prune -f --filter until=168h >/dev/null" || say "warning: build cache prune failed"

say "$IMAGE is live (instance ${instance:-unknown})"
