#!/usr/bin/env bash
# Deploy Cerebro to the ZimaOS box: deploy/zima/deploy.sh [--first-run]
#
# clean tree + `bun test` → rsync the repo to /DATA/AppData/cerebro/src → first run: secrets (root 700/600,
# generated on the server, never printed) and data dirs → build cerebro-server:<sha7> on the server, keep the
# running image as :prev → bge-m3 present with the digest pinned in deploy/.env → db + ollama up → migrate in
# a one-off container → start the new server → health gate (/health ok + db within 60 s), else roll back to
# :prev and exit 1 → register the ZimaOS app (first time) or refresh its stored compose.
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

[[ -z $(git status --porcelain) ]] || die "working tree is dirty; commit first (the image tag is the commit)"
bun test || die "bun test failed; not deploying"

SHA=$(git rev-parse --short=7 HEAD)
IMAGE=cerebro-server:$SHA
NEXT=$APP/docker-compose.next.yml # the release being deployed; becomes $COMPOSE once healthy

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

# Polls /health for up to 60 s; on {ok: true, db: true} prints the instanceId and succeeds.
health_gate() {
  local body
  for _ in $(seq 1 30); do
    body=$(zssh "curl -s -m 2 http://127.0.0.1:8790/health" || true)
    if [[ -n $body ]] && jq -e '.ok == true and .db == true' >/dev/null 2>&1 <<<"$body"; then
      jq -r '.instanceId // empty' <<<"$body"
      return 0
    fi
    sleep 2
  done
  return 1
}

# Runs on the server as root (via zfn). Creates the secrets once (kept on later runs) and the data dirs.
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

say "deploying $IMAGE to $ZIMA_HOST"
if ((FIRST_RUN)); then
  zfn first_run_setup "$SECRETS" "$DATA"
else
  zssh "sudo test -s $SECRETS/db.env && sudo test -s $SECRETS/server.env" ||
    die "no secrets on the server; run deploy/zima/deploy.sh --first-run"
fi

zssh "sudo mkdir -p $SRC $STATE && sudo chown -R \$(id -un) $SRC"
rsync -az --delete --exclude=.git --exclude=.claude --exclude=.superpowers --exclude-from=.gitignore \
  -e "ssh ${ZSSH_OPTS[*]}" ./ "$ZIMA_HOST:$SRC/"

say "building $IMAGE on the server"
zssh "sudo docker build -t $IMAGE -f $SRC/server/Dockerfile $SRC"
running=$(zssh "sudo docker inspect -f '{{.Config.Image}}' cerebro-server 2>/dev/null" || true)
if [[ -n $running && $running != "$IMAGE" ]]; then
  zssh "sudo docker tag $running cerebro-server:prev"
  say "kept $running as cerebro-server:prev"
fi

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
say "migrating"
zssh "sudo docker compose -f $NEXT run --rm --no-deps server bun server/src/cli.ts migrate" ||
  die "migration failed; the running server is unchanged"

say "starting $IMAGE"
zssh "sudo docker compose -f $NEXT up -d --no-deps server"
if ! instance=$(health_gate); then
  zssh "sudo rm -f $NEXT"
  logs="ssh zima sudo docker logs --tail 50 cerebro-server"
  zssh "sudo docker image inspect cerebro-server:prev >/dev/null 2>&1" ||
    die "$IMAGE failed the health gate and there is no cerebro-server:prev to roll back to; see: $logs"
  render_compose prev | zssh "sudo tee $COMPOSE >/dev/null"
  zssh "sudo docker compose -f $COMPOSE up -d --no-deps server"
  health_gate >/dev/null && die "$IMAGE failed the health gate; rolled back to cerebro-server:prev (healthy)"
  die "$IMAGE failed the health gate; rolled back to cerebro-server:prev, which is NOT healthy either; see: $logs"
fi

zssh "sudo mv $NEXT $COMPOSE"
printf '%s\n' "$instance" | zssh "sudo tee $STATE/instance-id >/dev/null"
printf '%s %s\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | zssh "sudo tee $STATE/deployed >/dev/null"

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
say "$IMAGE is live (instance ${instance:-unknown})"
