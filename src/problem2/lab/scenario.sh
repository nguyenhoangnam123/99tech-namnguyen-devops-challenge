#!/usr/bin/env bash
# Runs inside a lab container: starts NGINX, or breaks or recovers one scenario.
# Usage: scenario.sh start|break|recover, with SCENARIO set by lab/run.sh.
set -euo pipefail
scenario=${SCENARIO:?set SCENARIO}

traffic() { curl -s "http://127.0.0.1/$1/[1-$2]" >/dev/null || true; }
signal() { nginx -s "$1" 2>&1 | { grep -v 'signal process started' || true; } >&2; }

# Appends access log lines until the filesystem has keep_kib KiB left.
fill_log() {
  local file=$1 keep_kib=$2 avail
  avail=$(df -Pk "$(dirname "$file")" | awk 'NR == 2 {print $4}')
  awk 'BEGIN { for (i = 0; ; i++) printf "10.0.%d.%d - - [20/Nov/2026:10:%02d:%02d +0000] \"GET /api/orders/%d HTTP/1.1\" 200 %d \"-\" \"k6/0.54\"\n", i % 250, i % 200, i / 60 % 60, i % 60, i, 200 + i % 800 }' |
    head -c $(((avail - keep_kib) * 1024)) >>"$file" || true
}

case $1:$scenario in
# Requests for URLs not cached yet; counts complete, truncated and failed replies.
probe:*)
  path=api n=100
  [[ $scenario != cache-unbounded ]] || path=blob n=20
  curl -s -o /dev/null -w '%{http_code} %{size_download} %header{content-length}\n' \
    "http://127.0.0.1/$path/probe-$2-[1-$n]" |
    awk '{ s = $1 == "000" ? "no reply" : ($3 != "" && $2 != $3 ? $1 " truncated" : $1); c[s]++ }
      END { for (s in c) { printf "%s%d x %s", sep, c[s], s; sep = ", " }; print "" }' || true
  ;;
# Ubuntu's installer leaves part of the disk out of the root volume; this copies it.
start:lvm-free)
  truncate -s 400M /srv/disk.img
  loop=$(losetup -f --show /srv/disk.img)
  pvcreate -qq "$loop" && vgcreate -qq lab "$loop" && lvcreate -qq -y -L 100M -n logs lab
  mkfs.ext4 -q /dev/lab/logs && mount /dev/lab/logs /var/log
  ;&
start:*)
  mkdir -p /var/log/nginx /var/log/lb /var/cache/nginx
  chown www-data: /var/cache/nginx
  cp /lab/conf/backend.conf /etc/nginx/conf.d/backend.conf
  cp "/lab/conf/$scenario.conf" /etc/nginx/conf.d/lb.conf
  nginx
  exec sleep infinity
  ;;
# Releases the loop device and volume group, which live in the Docker host kernel.
teardown:lvm-free)
  loop=$(pvs --noheadings -o pv_name -S vg_name=lab | tr -d ' ')
  signal quit && sleep 1
  umount /var/log && vgremove -qq -fy lab && pvremove -qq -fy "$loop" && losetup -d "$loop"
  ;;
teardown:*) ;;
# Someone deletes the big access log; NGINX keeps writing to the open file.
break:deleted-open)
  traffic api 100
  fill_log /var/log/nginx/access.log 300
  rm /var/log/nginx/access.log
  traffic api 100
  ;;
recover:deleted-open)
  signal reopen
  sleep 1
  ;;
break:log-not-rotated)
  traffic api 100
  fill_log /var/log/lb/access.log 300
  ;;
# Rotate by hand, archive off the full filesystem, then add the missing rule.
recover:log-not-rotated)
  mv /var/log/lb/access.log /var/log/lb/access.log.1
  signal reopen
  sleep 1
  mkdir -p /srv/archive
  gzip -c /var/log/lb/access.log.1 >/srv/archive/access.log.1.gz
  rm /var/log/lb/access.log.1
  cp /lab/conf/logrotate-lb /etc/logrotate.d/lb
  logrotate -d /etc/logrotate.d/lb 2>&1 | grep -m1 'considering log'
  ;;
break:lvm-free)
  traffic api 100
  fill_log /var/log/nginx/access.log 300
  ;;
# Online: lvextend grows the volume, then -r grows ext4 while it stays mounted.
recover:lvm-free)
  lvextend -qq -r -l +100%FREE /dev/lab/logs 2>&1 | grep -v '^resize2fs\|^old_desc\|^$' || true
  ;;
break:inodes)
  traffic api 5000
  ;;
# NGINX treats a missing cache file as a miss, so this is safe while serving.
recover:inodes)
  find /var/cache/nginx/api -mindepth 1 -delete
  ;;
break:cache-unbounded)
  traffic blob 80
  ;;
# Add max_size and reload; the cache manager evicts down to it.
recover:cache-unbounded)
  sed -i 's/inactive=1d/max_size=32m inactive=1d/' /etc/nginx/conf.d/lb.conf
  nginx -t -q
  signal reload
  for _ in $(seq 30); do
    (($(df -P /var/cache/nginx | awk 'NR == 2 {print $5 + 0}') <= 60)) && break
    sleep 1
  done
  ;;
# max_size is enforced after the fact by the cache manager, so a burst overshoots it.
burst:cache-unbounded)
  curl -s -o /dev/null -w '%{http_code} %{size_download} %header{content-length}\n' \
    "http://127.0.0.1/blob/burst-[1-100]" |
    awk '{ s = $2 != $3 ? $1 " truncated" : $1; c[s]++ }
      END { for (s in c) { printf "%s%d x %s", sep, c[s], s; sep = ", " }; print "" }' || true
  df -h --output=pcent /var/cache/nginx | awk 'NR == 2 {print "just after: " $1}'
  sleep 10
  ;;
*)
  echo "unknown step $1 for $scenario" >&2
  exit 2
  ;;
esac
