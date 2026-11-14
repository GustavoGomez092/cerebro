#!/usr/bin/env bash
# End-to-end check of Cerebro on the ZimaOS box: deploy/zima/check.sh
# One line per check; prints `ALL OK`, or `FAILED: <names>` and exits 1. Warnings don't fail the run.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deploy/zima/lib.sh
source "$HERE/lib.sh"
command -v jq >/dev/null || die "needs jq"

BACKUP_MOUNT=/DATA/Backup
BACKUPS=$BACKUP_MOUNT/cerebro
TOKEN_FILE=$SECRETS/check.token # the `check` machine token (bun server/src/cli.ts token create check)

FAILED=""
WARNED=0
ok() { printf 'ok    %-13s %s\n' "$1" "$2"; }
warn() { printf 'warn  %-13s %s\n' "$1" "$2"; WARNED=$((WARNED + 1)); }
fail() { printf 'FAIL  %-13s %s\n' "$1" "$2"; FAILED="$FAILED $1"; }

healthy() { [[ -n $1 ]] && jq -e '.ok == true and .db == true' >/dev/null 2>&1 <<<"$1"; }
health_detail() {
  [[ -n $1 ]] || { echo "unreachable"; return; }
  jq -r '"ok=\(.ok) db=\(.db)"' <<<"$1" 2>/dev/null || echo "unexpected response"
}

# shellcheck disable=SC2329 # invoked on the server through zfn
# Runs on the server as root (via zfn): the token is read and sent there, never printed or copied off the box.
status_fetch() {
  local tok
  [[ -s $1 ]] || return 3
  tok=$(tr -d '[:space:]' <"$1")
  printf 'Authorization: Bearer %s\n' "$tok" | curl -s -f -m 10 -H @- http://127.0.0.1:8790/v1/status
}

# shellcheck disable=SC2329 # invoked on the server through zfn
# Runs on the server as root (via zfn): per container, "<name> <anon+shmem bytes> <limit> <oom kills>" from its
# cgroup (v2) files, or "<name> missing". docker stats' MemPerc counts the page cache, which the kernel reclaims
# before it OOM-kills: for Postgres it reads near 100 % on a healthy box.
mem_report() {
  local c
  for c in "$@"; do
    { docker exec "$c" sh -c 'cd /sys/fs/cgroup && echo "limit $(cat memory.max)" && cat memory.stat memory.events' 2>/dev/null || true; } |
      awk -v c="$c" '$1 == "limit" { l = $2 } $1 == "anon" || $1 == "shmem" { u += $2 } $1 == "oom_kill" { k = $2 }
        END { if (l == "") print c, "missing"; else printf "%s %.0f %s %.0f\n", c, u, l, k }'
  done
}

# /health through Caddy (from this Mac) and on the server itself.
url=http://cerebro.home.lab/health
lan=$(curl -s -m 5 "$url" || true)
if healthy "$lan"; then ok health-lan "$url"; else fail health-lan "$url: $(health_detail "$lan")"; fi
url=http://127.0.0.1:8790/health
local_health=$(zssh "curl -s -m 5 $url" || true)
if healthy "$local_health"; then ok health-local "$url"; else fail health-local "$url: $(health_detail "$local_health")"; fi

# The instance recorded at the last deploy: a different id means the database was replaced.
want=$(zssh "sudo cat $STATE/instance-id 2>/dev/null" || true)
got=$(jq -r '.instanceId // empty' <<<"$local_health" 2>/dev/null || true)
if [[ -z $want ]]; then
  fail instance-id "no deploy record in $STATE/instance-id"
elif [[ $got == "$want" ]]; then
  ok instance-id "$got (unchanged since the last deploy)"
else
  fail instance-id "server reports ${got:-none}, the last deploy recorded $want (database replaced?)"
fi

rc=0
status=$(zfn status_fetch "$TOKEN_FILE") || rc=$?
if ((rc == 3)); then
  fail status "no check token in $TOKEN_FILE"
elif ((rc != 0)) || ! jq -e '.queue and .embedder' >/dev/null 2>&1 <<<"$status"; then
  fail status "/v1/status failed (curl exit $rc; token revoked or server down?)"
else
  ok status "/v1/status answers for machine $(jq -r '.machine' <<<"$status")"

  pending=$(jq -r '.queue.pending' <<<"$status")
  dead=$(jq -r '.queue.dead' <<<"$status")
  oldest=$(jq -r '.queue.oldestPendingSeconds' <<<"$status")
  if ((dead > 0)); then
    fail queue "pending $pending, dead $dead (retry them: bun server/src/cli.ts requeue-dead)"
  else
    ok queue "pending $pending, dead 0, oldest pending ${oldest}s"
  fi

  # Seconds since the embedder's last success ("" when none since the server started).
  age=$(jq -r 'if .embedder.lastSuccessAt then (now - (.embedder.lastSuccessAt[0:19] + "Z" | fromdateiso8601)) | floor else "" end' <<<"$status")
  if [[ -n $age ]] && ((age < 3600)); then
    ok embedder "last success $((age / 60)) min ago"
  elif ((pending == 0)); then
    ok embedder "idle (queue empty)"
  else
    last="never since the server started"
    [[ -z $age ]] || last="$((age / 60)) min ago"
    fail embedder "$pending pending, last success $last"
  fi

  reason=$(jq -r '.summariser.paused.reason // empty' <<<"$status")
  if ! jq -e 'has("summariser")' >/dev/null <<<"$status"; then
    warn summariser "not reported by /v1/status"
  elif [[ $reason == login ]]; then
    fail summariser "paused: Claude login expired (ssh -t zima sudo docker exec -it -u cerebro cerebro-server claude auth login)"
  elif [[ -n $reason ]]; then
    ok summariser "paused: $reason (jobs wait, nothing is lost)"
  else
    ok summariser "running"
  fi

  gb=$(jq -r '.dbBytes / 1e9 | floor' <<<"$status")
  if ((gb >= 150)); then
    fail db-size "$gb GB, over the 150 GB budget"
  elif ((gb >= 120)); then
    warn db-size "$gb GB, nearing the 150 GB budget"
  else
    ok db-size "$gb GB"
  fi
fi

models=$(zssh "sudo docker exec cerebro-ollama ollama list" || true)
if grep -q '^bge-m3:' <<<"$models"; then ok bge-m3 "present in cerebro-ollama"; else fail bge-m3 "not in cerebro-ollama (re-run deploy)"; fi

timer=$(zssh "systemctl is-active cerebro-backup.timer" || true)
if [[ $timer == active ]]; then ok backup-timer "cerebro-backup.timer active"; else fail backup-timer "cerebro-backup.timer is ${timer:-unknown}"; fi

recent=$(zssh "sudo find $BACKUPS -name '*.dump' -mmin -1560 2>/dev/null | head -n 1" || true)
if [[ -n $recent ]]; then ok backup-age "$(basename "$recent") is under 26 h old"; else fail backup-age "no dump under $BACKUPS in the last 26 h"; fi

# The backup drive is shared (zima-backup snapshots, postgres-backup); backup.sh keeps a reserve, this warns earlier.
used=$(zssh "df -P $BACKUP_MOUNT | awk -v m=$BACKUP_MOUNT 'NR == 2 { print (\$6 == m ? \$5 : \"unmounted\") }'" || true)
if [[ $used == unmounted ]]; then
  warn backup-disk "$BACKUP_MOUNT is not mounted"
elif [[ ! $used =~ ^[0-9]+%$ ]]; then
  warn backup-disk "could not read the use of $BACKUP_MOUNT"
elif ((${used%\%} > 80)); then
  warn backup-disk "$BACKUP_MOUNT $used used (shared with the zima-backup snapshots; prune or free space)"
else
  ok backup-disk "$BACKUP_MOUNT $used used"
fi

# Memory the kernel can't reclaim (anon + shmem: Postgres' shared buffers) as a share of each container's hard
# limit (no swap, so 100 % means the OOM killer). OOM kills inside a container that kept running (a Postgres
# backend, a model runner) are a warning: the container recovered, but its limit was hit.
mem=$(zfn mem_report cerebro-db cerebro-ollama cerebro-server || true)
mem_bad=""
mem_ok=""
mem_warn=""
for c in cerebro-db cerebro-ollama cerebro-server; do
  read -r used limit kills < <(awk -v n="$c" '$1 == n { print $2, $3, $4 }' <<<"$mem") || true
  if [[ -z ${used-} || $used == missing ]]; then
    mem_bad="$mem_bad, $c not running"
    continue
  fi
  if [[ ! $limit =~ ^[0-9]+$ ]]; then
    mem_bad="$mem_bad, $c has no memory limit"
    continue
  fi
  pct=$((used * 100 / limit))
  if ((pct >= 90)); then mem_bad="$mem_bad, $c at ${pct}% of its limit (anon+shmem)"; else mem_ok="$mem_ok $c ${pct}%"; fi
  if ((kills > 0)); then mem_warn="$mem_warn, $c: $kills OOM kill(s) since the container started"; fi
done
if [[ -n $mem_bad ]]; then
  fail memory "${mem_bad#, }"
elif [[ -n $mem_warn ]]; then
  warn memory "${mem_warn#, } (now:$mem_ok)"
else
  ok memory "${mem_ok# } (anon+shmem of each limit)"
fi

if [[ -z $FAILED ]]; then
  if ((WARNED)); then echo "ALL OK ($WARNED warning(s))"; else echo "ALL OK"; fi
  exit 0
fi
echo "FAILED:$FAILED"
exit 1
