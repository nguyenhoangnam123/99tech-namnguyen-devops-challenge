#!/usr/bin/env bash
# Reproduces each full-disk cause in a container, checks triage.sh names it,
# recovers without restarting NGINX, and checks the cause is gone and requests succeed.
# Usage: lab/run.sh [scenario...]; lvm-free is opt-in, as it needs --privileged.
set -euo pipefail
cd "$(dirname "$0")"
image=p2-lab:local
out=$(mktemp -d)
scenarios=("$@")
((${#scenarios[@]})) || scenarios=(deleted-open log-not-rotated inodes cache-unbounded cache-limit parsing)
failed=0

# shellcheck disable=SC2317 # called by the EXIT trap
cleanup() {
  local ids
  mapfile -t ids < <(docker ps -aq --filter label=p2-lab)
  for id in "${ids[@]}"; do docker exec "$id" /lab/scenario.sh teardown >/dev/null 2>&1 || true; done
  ((${#ids[@]} == 0)) || docker rm -f "${ids[@]}" >/dev/null
  [[ -n ${KEEP_IMAGE:-} ]] || docker rmi -f "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mount_of() {
  case $1 in
  deleted-open | log-not-rotated) echo /var ;;
  lvm-free) echo /var/log ;;
  *) echo /var/cache/nginx ;;
  esac
}
# A small filesystem per scenario, so df really reads full.
fs_args() {
  case $1 in
  inodes) echo "--tmpfs=$(mount_of "$1"):size=64m,nr_inodes=3000" ;;
  lvm-free) echo "--privileged" ;;
  *) echo "--tmpfs=$(mount_of "$1"):size=64m" ;;
  esac
}
# Every probe line must read N x 200, with nothing truncated or failed.
all_ok() { ! grep -Eq 'truncated|no reply|x [013-9][0-9][0-9]' <<<"$1"; }

# The parsing case: tricky NGINX and logrotate configs, checked against the report.
check_parsing() {
  local report=$1 ok=1
  want() { if grep -Eq -- "$1" "$report"; then echo "  found:  $1"; else echo "  MISSING: $1"; ok=0; fi; }
  never() { if grep -Eq -- "$1" "$report"; then echo "  UNEXPECTED: $1"; ok=0; else echo "  absent: $1"; fi; }
  want '^- log-not-rotated: /var/log/sub/quoted.log '
  want '^/var/log/mid/access.log: .*rule: daily'
  want '^cache /var/cache/nginx/api: .*max_size=32m'
  never 'cache-unbounded'
  never 'rotate-no-reopen'
  never 'log-not-rotated: /var/log/mid/'
  ((ok))
}

docker build -q -t "$image" . >/dev/null
for s in "${scenarios[@]}"; do
  c=p2-lab-$s
  mnt=$(mount_of "$s")
  ex() { docker exec "$c" "$@"; }
  usage() { ex df -h --output=size,used,avail,pcent,ipcent "$mnt" | awk -v m="$mnt" 'NR == 2 {print m, $0}'; }

  echo "== $s"
  # Small socket buffers, as for a distant client, so NGINX must spool large responses.
  docker run -d --name "$c" --label p2-lab -e SCENARIO="$s" "$(fs_args "$s")" \
    --sysctl net.ipv4.tcp_rmem='4096 16384 16384' --sysctl net.ipv4.tcp_wmem='4096 16384 16384' "$image" >/dev/null
  docker cp -q ../scripts/triage.sh "$c:/usr/local/sbin/triage"
  for _ in $(seq 50); do
    if ex curl -sf -o /dev/null http://127.0.0.1/; then break; fi
    sleep 0.2
  done

  if [[ $s == parsing ]]; then
    ex /lab/scenario.sh break
    ex triage >"$out/$s.txt"
    if check_parsing "$out/$s.txt"; then echo "PASS"; else echo "FAIL"; failed=1; fi
    docker rm -f "$c" >/dev/null
    continue
  fi

  ex /lab/scenario.sh break
  echo "broken:    $(usage)  (size used avail use% inodes%)"
  ex triage >"$out/$s-broken.txt"
  found=$(grep "^- $s:" "$out/$s-broken.txt" || true)
  ex /lab/scenario.sh probe broken | sed 's/^/requests:  /'
  echo "triage:    ${found:-NOT FOUND}"

  docker exec -d "$c" /lab/scenario.sh load
  sleep 1
  ex /lab/scenario.sh recover | sed 's/^/recovery:  /'
  sleep 2
  echo "during:    $(ex /lab/scenario.sh unload)  (live GETs, 1 s before recovery to 2 s after)"
  echo "recovered: $(usage)"
  ex triage >"$out/$s-recovered.txt"
  left=$(grep "^- $s:" "$out/$s-recovered.txt" || true)
  served=$(ex /lab/scenario.sh probe recovered)
  printf 'requests:  %s\n' "${served//$'\n'/$'\n'requests:  }"

  if [[ $s == cache-unbounded ]]; then
    ex /lab/scenario.sh burst | sed 's/^/burst:     /'
    echo "10 s later: $(usage)"
  fi

  if [[ -n $found && -z $left ]] && all_ok "$served"; then echo "PASS"; else echo "FAIL"; failed=1; fi
  ex /lab/scenario.sh teardown
  docker rm -f "$c" >/dev/null
done
echo "Full triage reports: $out"
exit "$failed"
