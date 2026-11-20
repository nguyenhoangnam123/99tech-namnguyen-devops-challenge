#!/usr/bin/env bash
# Reproduces each full-disk cause in a container, checks triage.sh names it,
# recovers, and checks the cause is gone. Usage: lab/run.sh [scenario...]
# lvm-free is opt-in: it needs --privileged for a loop device and LVM.
set -euo pipefail
cd "$(dirname "$0")"
image=p2-lab:local
out=$(mktemp -d)
scenarios=("$@")
((${#scenarios[@]})) || scenarios=(deleted-open log-not-rotated inodes cache-unbounded)
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

mount_of() { case $1 in deleted-open | log-not-rotated | lvm-free) echo /var/log ;; *) echo /var/cache/nginx ;; esac; }
# A small filesystem per scenario, so df really reads full.
fs_args() {
  case $1 in
  inodes) echo "--tmpfs=$(mount_of "$1"):size=64m,nr_inodes=3000" ;;
  lvm-free) echo "--privileged" ;;
  *) echo "--tmpfs=$(mount_of "$1"):size=64m" ;;
  esac
}

docker build -q -t "$image" . >/dev/null
for s in "${scenarios[@]}"; do
  c=p2-lab-$s
  mnt=$(mount_of "$s")
  ex() { docker exec "$c" "$@"; }
  usage() { ex df -h --output=size,used,avail,pcent,ipcent "$mnt" | awk -v m="$mnt" 'NR == 2 {print m, $0}'; }

  echo "== $s"
  docker run -d --name "$c" --label p2-lab -e SCENARIO="$s" "$(fs_args "$s")" "$image" >/dev/null
  docker cp -q ../scripts/triage.sh "$c:/usr/local/sbin/triage"
  for _ in $(seq 50); do
    if ex curl -sf -o /dev/null http://127.0.0.1/; then break; fi
    sleep 0.2
  done

  ex /lab/scenario.sh break
  echo "broken:    $(usage)  (size used avail use% inodes%)"
  ex triage >"$out/$s-broken.txt"
  found=$(grep "^- $s:" "$out/$s-broken.txt" || true)
  echo "requests:  $(ex /lab/scenario.sh probe broken)"
  echo "triage:    ${found:-NOT FOUND}"

  ex /lab/scenario.sh recover | sed 's/^/recovery:  /'
  echo "recovered: $(usage)"
  ex triage >"$out/$s-recovered.txt"
  left=$(grep "^- $s:" "$out/$s-recovered.txt" || true)
  served=$(ex /lab/scenario.sh probe recovered)
  echo "requests:  $served"

  if [[ $s == cache-unbounded ]]; then
    ex /lab/scenario.sh burst | sed 's/^/burst:     /'
    echo "10 s later: $(usage)"
  fi

  if [[ -n $found && -z $left && $served =~ ^[0-9]+\ x\ 200$ ]]; then echo "PASS"; else echo "FAIL"; failed=1; fi
  ex /lab/scenario.sh teardown
  docker rm -f "$c" >/dev/null
done
echo "Full triage reports: $out"
exit "$failed"
