#!/usr/bin/env bash
# Runs inside a lab container: starts NGINX, breaks or recovers one scenario, or probes it.
# Usage: scenario.sh start|break|recover|probe <tag>|load|unload|teardown, with SCENARIO set.
set -euo pipefail
scenario=${SCENARIO:?set SCENARIO}

traffic() { curl -s "http://127.0.0.1/$1/[1-$2]" >/dev/null || true; }
signal() { nginx -s "$1" 2>&1 | { grep -v 'signal process started' || true; } >&2; }

# Appends access log lines until the filesystem is completely full.
fill_log() {
  awk 'BEGIN { for (i = 0; ; i++) printf "10.0.%d.%d - - [20/Nov/2026:10:%02d:%02d +0000] \"GET /api/orders/%d HTTP/1.1\" 200 %d \"-\" \"k6/0.54\"\n", i % 250, i % 200, i / 60 % 60, i % 60, i, 200 + i % 800 }' \
    >>"$1" 2>/dev/null || true
}

# Counts replies by status; a body shorter than its Content-Length counts as truncated.
count() {
  awk -v label="$1" '{ s = $1 == "000" ? "no reply" : ($3 != "" && $2 != $3 ? $1 " truncated" : $1); c[s]++ }
    END { printf "%s", label; for (s in c) { printf "%s %d x %s", sep, c[s], s; sep = "," }; print "" }'
}
reply='%{http_code} %{size_download} %header{content-length}\n'

# Bytes in every access log NGINX holds open, deleted ones included.
access_log_bytes() {
  local fd total=0
  for fd in /proc/"$(cat /run/nginx.pid)"/fd/*; do
    [[ $(readlink "$fd" 2>/dev/null) == *access.log* ]] || continue
    total=$((total + $(stat -L -c %s "$fd")))
  done
  echo "$total"
}

case $1:$scenario in
# New URLs only: small GETs, request bodies over the in-memory buffer, large slow downloads.
probe:*)
  before=$(access_log_bytes)
  curl -s -o /dev/null -w "$reply" "http://127.0.0.1/api/get-$2-[1-100]" | count "GET 3 B:" || true
  curl -s -o /dev/null -w "$reply" --data-binary @/srv/post.bin "http://127.0.0.1/api/post-$2-[1-20]" |
    count "POST 64 KiB:" || true
  curl -s -Z --limit-rate 512k -o /dev/null -w "$reply" "http://127.0.0.1/blob/slow-$2-[1-5]" |
    count "GET 1 MiB to a slow client:" || true
  echo "access log: +$(($(access_log_bytes) - before)) bytes for those 125 requests"
  ;;
# About 15 small GETs a second until unload: what recovery does to live traffic.
load:*)
  echo $$ >/root/load.pid
  for ((i = 0; ; i++)); do
    curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1/api/during-$i" >>/root/load.txt || true
    sleep 0.05
  done
  ;;
unload:*)
  kill "$(cat /root/load.pid)"
  sleep 0.2
  awk '{c[$1 == "000" ? "no reply" : $1]++} END {for (s in c) {printf "%s%d x %s", sep, c[s], s; sep = ", "}; print ""}' /root/load.txt
  ;;
# Ubuntu's installer leaves part of the disk out of the root volume; this copies it.
start:lvm-free)
  truncate -s 400M /srv/disk.img
  loop=$(losetup -f --show /srv/disk.img)
  pvcreate -qq "$loop" && vgcreate -qq lab "$loop" && lvcreate -qq -y -L 100M -n logs lab
  mkfs.ext4 -q /dev/lab/logs && mount /dev/lab/logs /var/log
  ;&
start:parsing)
  mkdir -p /etc/nginx/extra /var/log/mid /var/log/sub
  cp /lab/conf/parsing/quoted.conf /etc/nginx/extra/
  ;&
start:*)
  # Log scenarios mount a fresh /var: logs and temp files share it, as on the VM.
  mkdir -p /var/log/nginx /var/log/lb /var/lib/nginx /var/lib/logrotate /var/cache/nginx /var/tmp
  [[ -e /var/run ]] || ln -s /run /var/run
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
# Logs of a fixed size, for the config parsing checks.
break:parsing)
  traffic api 10
  for log in /var/log/mid/access.log /var/log/sub/quoted.log; do
    awk 'BEGIN { for (;;) print "10.0.0.1 - - [20/Nov/2026:10:00:00 +0000] \"GET /api HTTP/1.1\" 200 3" }' |
      head -c 12582912 >>"$log" || true
  done
  cp /lab/conf/parsing/mid /lab/conf/parsing/wide /lab/conf/parsing/sub.dpkg-old /etc/logrotate.d/
  ;;
# Someone deletes the big access log; NGINX keeps writing to the open file.
break:deleted-open)
  traffic api 100
  fill_log /var/log/nginx/access.log
  rm /var/log/nginx/access.log
  ;;
recover:deleted-open)
  signal reopen
  sleep 1
  ;;
break:log-not-rotated)
  traffic api 100
  fill_log /var/log/lb/access.log
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
  logrotate -d /etc/logrotate.d/lb 2>&1 | awk '/considering log/ && !n++'
  ;;
break:lvm-free)
  traffic api 100
  fill_log /var/log/nginx/access.log
  ;;
# Online: lvextend grows the volume by what is needed, then -r grows ext4 while mounted.
recover:lvm-free)
  lvextend -qq -r -L +200M /dev/lab/logs 2>&1 | awk '!/^resize2fs|^old_desc|^$/'
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
  curl -s -o /dev/null -w "$reply" "http://127.0.0.1/blob/burst-[1-100]" | count "100 new 1 MiB objects:" || true
  df -h --output=pcent /var/cache/nginx | awk 'NR == 2 {print "just after: " $1}'
  sleep 10
  ;;
# A max_size sized to the volume: the cache manager holds the disk near full.
break:cache-limit)
  traffic blob 80
  sleep 10
  ;;
recover:cache-limit)
  sed -i 's/max_size=63m/max_size=44m/' /etc/nginx/conf.d/lb.conf
  nginx -t -q
  signal reload
  for _ in $(seq 30); do
    (($(df -P /var/cache/nginx | awk 'NR == 2 {print $5 + 0}') <= 70)) && break
    sleep 1
  done
  ;;
*)
  echo "unknown step $1 for $scenario" >&2
  exit 2
  ;;
esac
