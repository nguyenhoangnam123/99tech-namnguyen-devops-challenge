#!/usr/bin/env bash
# Read-only disk triage for an NGINX host: it never deletes, moves or truncates.
# Usage: sudo triage.sh   Tune with WARN_PCT (90), MIN_MB (10), BIG_MB (1024), SAMPLE_S (5).
set -euo pipefail

# Re-runs itself niced; ionice's idle class only helps where the IO scheduler honours it.
if [[ -z ${TRIAGE_NICED:-} && -f $0 ]]; then
  export TRIAGE_NICED=1
  prio=(nice -n 19)
  if command -v ionice >/dev/null && ionice -c3 true 2>/dev/null; then prio+=(ionice -c3); fi
  exec "${prio[@]}" "$BASH" "$0" "$@"
fi
# Bash here-documents and sort spill to TMPDIR; keep that off the full disk.
if [[ -d /dev/shm && -w /dev/shm ]]; then export TMPDIR=/dev/shm; fi

warn_pct=${WARN_PCT:-90}
min_mb=${MIN_MB:-10}
big_mb=${BIG_MB:-1024}
sample_s=${SAMPLE_S:-5}
gib=$((1 << 30))
causes=()
notes=()

# If anything aborts the run, still print what was found.
failed_line='?'
trap 'failed_line=$LINENO' ERR
on_exit() {
  if (($1 != 0)); then
    echo "triage stopped at line $failed_line (exit $1); causes found so far:" >&2
    printf -- '- %s\n' "${causes[@]:-none}" >&2
  fi
}
trap 'on_exit $?' EXIT

section() { printf '\n== %s\n' "$1"; }
cause() { causes+=("$1"); }
mib() { echo $((($1 + 1048575) / 1048576)); }
# Bounds commands that can hang on a dead mount or a held lock.
to() { timeout 20 "$@"; }
fs_kb() { to df -Pkl "$1" 2>/dev/null | awk 'NR == 2 {print $2, $3, $4}' || true; }
same_fs() { [[ $(stat -c %d "$1" 2>/dev/null) == "$(stat -c %d "$2" 2>/dev/null)" ]]; }
# NGINX sizes such as 512, 64k, 10m or 1g, in KiB.
size_kb() { awk -v s="$1" 'BEGIN { u = tolower(substr(s, length(s))); f = u == "k" ? 1 : u == "m" ? 1024 : u == "g" ? 1048576 : 1 / 1024; printf "%d", (s + 0) * f }'; }

# One pass per directory: allocated KiB and file count. -H follows a symlinked argument.
declare -A kb_of=() files_of=()
walk() {
  [[ -z ${kb_of[$1]:-} ]] || return 0
  local out
  out=$(find -H "$1" -xdev -type f -printf '%b\n' 2>/dev/null | awk '{b += $1; n++} END {print int(b / 2), n + 0}' || true)
  kb_of[$1]=${out% *}
  files_of[$1]=${out#* }
}

# NGINX config as one statement per line: quotes respected, comments dropped, includes expanded.
# Reading files directly, because 'nginx -T' opens, and so creates, every log file.
# shellcheck disable=SC2016 # awk program, not shell
split_awk='
  function emit() { gsub(/[ \t]+/, " ", buf); sub(/^ /, "", buf); sub(/ $/, "", buf); if (buf != "") print buf; buf = "" }
  { for (i = 1; i <= length($0); i++) {
      c = substr($0, i, 1)
      if (q != "") { buf = buf c; if (c == q) q = ""; continue }
      if (c == "#") break
      if (c == "\"" || c == "\047") q = c
      if (c == ";" || c == "{" || c == "}") emit(); else buf = buf c
    }
    buf = buf " " }
  END { emit() }'
conf_statements() {
  local file stmt inc
  for file in "$@"; do
    [[ -f $file ]] || continue
    while IFS= read -r stmt; do
      if [[ $stmt == 'include '* ]]; then
        inc=${stmt#include }
        inc=${inc//[\"\']/}
        [[ $inc == /* ]] || inc=/etc/nginx/$inc
        # shellcheck disable=SC2086 # include paths are globs
        conf_statements $inc
      else
        printf '%s\n' "$stmt"
      fi
    done < <(awk "$split_awk" "$file")
  done
}
nginx_conf=$(conf_statements /etc/nginx/nginx.conf)
directive() { printf '%s\n' "$nginx_conf" | awk -v d="$1" '$1 == d { gsub(/["\047]/, ""); print }'; }

echo "Disk triage on $(hostname) at $(date -u +%FT%TZ); kernel $(uname -r)"
[[ $EUID -eq 0 ]] || echo "warning: not root, so other users' open files and some directories are hidden"
df_opts=(-l -x squashfs -x devtmpfs -x efivarfs)

section "Filesystems (bytes and inodes, local only)"
to df -hT "${df_opts[@]}" 2>/dev/null || true
full=()
byte_full=()
while read -r _ _ size used _ pct mnt; do
  pct=${pct%\%}
  if [[ ! $pct =~ ^[0-9]+$ ]] || ((pct < warn_pct)); then continue; fi
  full+=("$mnt")
  byte_full+=("$mnt")
  echo "FULL bytes: $mnt at $pct% ($((used / 1024)) of $((size / 1024)) MiB)"
done < <(to df -PTk "${df_opts[@]}" 2>/dev/null | tail -n +2 || true)
inode_full=()
while read -r _ inodes iused _ pct mnt; do
  pct=${pct%\%}
  if [[ ! $pct =~ ^[0-9]+$ ]] || ((pct < warn_pct)); then continue; fi
  inode_full+=("$mnt")
  [[ " ${full[*]} " == *" $mnt "* ]] || full+=("$mnt")
  echo "FULL inodes: $mnt at $pct% ($iused of $inodes); entries per directory:"
  depth=$(printf '%s\n' "$mnt" | awk -F/ '{print NF + 1}')
  find "$mnt" -xdev -printf '%h\n' 2>/dev/null |
    awk -F/ -v d="$depth" '{k = $1; for (i = 2; i <= d && i <= NF; i++) k = k "/" $i; c[k]++}
      END {for (k in c) printf "%10d  %s\n", c[k], k}' | sort -rn | head -5 || true
  cause "inodes: $mnt has used $pct% of its inodes ($iused files and directories); bytes are not the limit"
done < <(to df -Pi "${df_opts[@]}" 2>/dev/null | tail -n +2 || true)
((${#full[@]})) || echo "No filesystem at or above $warn_pct% of its bytes or inodes."
checked=("${full[@]:-/}")

# Usage at start and end tells a growing disk from one held at a limit.
start_s=$SECONDS
declare -A used0=()
for mnt in "${checked[@]}"; do
  read -r _ used _ < <(fs_kb "$mnt")
  used0[$mnt]=${used:-0}
done

# One du pass per full filesystem feeds both of the next two sections.
declare -A du_of=()
for mnt in "${checked[@]}"; do du_of[$mnt]=$(du -xk --max-depth=2 "$mnt" 2>/dev/null || true); done

# df counts blocks still held by open files; du only sees names in the tree.
section "Space df counts but du cannot see"
for mnt in "${checked[@]}"; do
  if [[ $(to df -PT "$mnt" | awk 'NR == 2 {print $2}' || true) == overlay ]]; then
    echo "$mnt: overlay filesystem, its lower layers are outside du's view; skipped"
    continue
  fi
  read -r _ used_kb _ < <(fs_kb "$mnt")
  du_kb=$(printf '%s\n' "${du_of[$mnt]}" | awk -v m="$mnt" '$2 == m {print $1}')
  gap_mb=$(((used_kb - ${du_kb:-0}) / 1024))
  echo "$mnt: df used $((used_kb / 1024)) MiB, du sees $((${du_kb:-0} / 1024)) MiB, gap $gap_mb MiB"
  ((gap_mb < min_mb)) || echo "  The gap is deleted files still held open, or files hidden under a mount point."
done

# Allocated blocks, not apparent size: a truncated file with a non-append writer is sparse.
section "Deleted files still held open"
declare -A alloc_of=() name_of=() holders=() owner_of=()
while IFS=$'\t' read -r fd target; do
  [[ $target != /dev/* && $target != /memfd:* ]] || continue
  read -r id alloc < <(stat -L -c '%d:%i %b %B' "$fd" 2>/dev/null | awk '{print $1, $2 * $3}') || continue
  pid=${fd#/proc/}
  pid=${pid%%/*}
  comm=$(cat "/proc/$pid/comm" 2>/dev/null || echo '?')
  alloc_of[$id]=$alloc
  name_of[$id]=${target% (deleted)}
  holders[$id]+="$comm $pid fd ${fd##*/}, "
  owner_of[$id]=${owner_of[$id]:-$comm $pid ${fd##*/}}
done < <(find /proc/[0-9]*/fd -mindepth 1 -maxdepth 1 -lname '/* (deleted)' -printf '%p\t%l\n' 2>/dev/null || true)
declare -A held_by=()
for id in "${!alloc_of[@]}"; do
  printf '%10s MiB  %s  held by %s\n' "$(mib "${alloc_of[$id]}")" "${name_of[$id]}" "${holders[$id]%, }"
done | sort -rn | head -10
for id in "${!alloc_of[@]}"; do
  read -r comm pid _ <<<"${owner_of[$id]}"
  held_by[$comm $pid]=$((${held_by[$comm $pid]:-0} + ${alloc_of[$id]}))
done
((${#alloc_of[@]})) || echo "None."
shippers='^(filebeat|fluent-bit|fluentd|td-agent.*|vector|amazon-cloudwat|cwagent|promtail|otelcol.*|splunkd|datadog-agent)$'
for holder in "${!held_by[@]}"; do
  bytes=${held_by[$holder]}
  (($(mib "$bytes") >= min_mb)) || continue
  comm=${holder% *}
  pid=${holder##* }
  if [[ $comm == nginx ]]; then
    cause "deleted-open: NGINX ($pid) holds $(mib "$bytes") MiB in deleted log files; 'nginx -s reopen' frees it"
  elif [[ $comm =~ $shippers ]]; then
    cause "shipper-holds-deleted: $comm ($pid) holds $(mib "$bytes") MiB of rotated, deleted logs; restart it and set it to close removed files"
  else
    cause "deleted-open: $comm ($pid) holds $(mib "$bytes") MiB in deleted files; restart it, or truncate via /proc/$pid/fd only if the content can be lost"
  fi
done

section "Largest directories"
for mnt in "${checked[@]}"; do
  echo "on $mnt:"
  printf '%s\n' "${du_of[$mnt]}" | sort -rn | head -10 | awk 'NF {printf "%10.1f MiB  %s\n", $1 / 1024, $2}' || true
done

section "Usual suspects"
for dir in /var/log /var/log/nginx /var/log/journal /var/cache/nginx /var/lib/nginx /var/lib/docker \
  /var/cache/apt/archives /var/crash /var/lib/snapd/snaps /tmp /var/tmp /boot; do
  [[ -e $dir ]] || continue
  walk "$dir"
  printf '%10s MiB  %s\n' "$((${kb_of[$dir]} / 1024))" "$dir"
done
crash_kb=${kb_of[/var/crash]:-0}
if ((crash_kb / 1024 >= min_mb)); then
  cause "crash-dumps: /var/crash holds $((crash_kb / 1024)) MiB; copy them off, then remove them"
fi
apt_kb=${kb_of[/var/cache/apt/archives]:-0}
if ((apt_kb / 1024 >= big_mb / 4)); then
  cause "apt-cache: $((apt_kb / 1024)) MiB of downloaded packages; 'apt-get clean' is safe"
fi
kernels=$(find /boot -maxdepth 1 -name 'vmlinuz-*' 2>/dev/null | wc -l || true)
if ((kernels > 2)); then
  cause "old-kernels: $kernels kernels in /boot; 'apt autoremove --purge' keeps the running one"
fi
if command -v snap >/dev/null; then
  disabled=$(to snap list --all 2>/dev/null | awk '/disabled/' | wc -l || true)
  ((disabled == 0)) || cause "snap-revisions: $disabled disabled snap revisions; 'snap set system refresh.retain=2'"
fi
if [[ -d /var/lib/docker/containers ]]; then
  docker_kb=$(find /var/lib/docker/containers -name '*-json.log*' -printf '%b\n' 2>/dev/null |
    awk '{s += $1} END {print int(s / 2)}' || true)
  capped=$(grep -s '"max-size"' /etc/docker/daemon.json || true)
  echo "Docker json-file logs: $((${docker_kb:-0} / 1024)) MiB; ${capped:+daemon.json sets max-size}"
  if [[ -z $capped ]] && ((${docker_kb:-0} / 1024 >= min_mb)); then
    cause "docker-logs: container logs hold $((docker_kb / 1024)) MiB under /var/lib/docker/containers and daemon.json sets no max-size"
  fi
fi

section "NGINX logs and rotation"
# logrotate skips files in its include directory with these extensions.
rotate_files=(/etc/logrotate.conf)
for f in /etc/logrotate.d/*; do
  [[ -f $f ]] || continue
  case $f in *.dpkg-* | *.ucf-* | *.disabled | *.rpmnew | *.rpmorig | *.rpmsave | *.swp | *.cfsaved | *,v | *~) continue ;; esac
  rotate_files+=("$f")
done
# One line per logrotate rule: its path patterns, a tab, then its directives.
rules=$(cat "${rotate_files[@]}" 2>/dev/null | sed 's/#.*//' | awk '
  { for (i = 1; i <= NF; i++) {
      t = $i
      if (skip) { skip = 0; continue }
      if (t == "{") { depth++; body = "" }
      else if (t == "}") { depth--; if (depth == 0) { print pats "\t" body; pats = "" } }
      else if (depth == 0 && t == "include") skip = 1
      else if (depth == 0 && t ~ /^"?\//) { gsub(/"/, "", t); pats = pats " " t }
      else if (depth == 1) body = body " " t
  } }' || true)
# logrotate globs: * and ? never match a slash.
# shellcheck disable=SC2016 # sed program, not shell
glob_re() { printf '%s' "$1" | sed -e 's/[.+^$(){}|\\]/\\&/g' -e 's/\*/[^\/]*/g' -e 's/?/[^\/]/g'; }
mapfile -t logs < <({
  { directive access_log; directive error_log; } | awk '$2 ~ /^\// && $2 !~ /^\/dev\// {print $2}'
  for log in /var/log/nginx/*.log; do [[ -e $log ]] && echo "$log"; done
} | sort -u)
declare -A log_bytes0=()
now=$(date +%s)
for log in "${logs[@]}"; do
  bytes=$(stat -c %s "$log" 2>/dev/null) || continue
  log_bytes0[$log]=$bytes
  rotated_kb=$(find "$(dirname "$log")" -maxdepth 1 -name "$(basename "$log")?*" -printf '%b\n' 2>/dev/null |
    awk '{s += $1} END {print int(s / 2)}' || true)
  rule=""
  while IFS=$'\t' read -r pats body; do
    read -ra patterns <<<"$pats"
    for pat in "${patterns[@]}"; do
      if [[ $log =~ ^$(glob_re "$pat")$ ]]; then rule=${body:- (empty)} && break 2; fi
    done
  done < <(printf '%s\n' "$rules")
  read -r fs_size _ _ < <(fs_kb "$log")
  if [[ -z $rule ]]; then
    echo "$log: $(mib "$bytes") MiB, rotated copies $((rotated_kb / 1024)) MiB, NOT covered by logrotate"
    if (($(mib "$bytes") >= min_mb)); then
      cause "log-not-rotated: $log is $(mib "$bytes") MiB and no logrotate rule matches it"
    fi
    continue
  fi
  summary=${rule%% sharedscripts*}
  echo "$log: $(mib "$bytes") MiB, rotated copies $((rotated_kb / 1024)) MiB; rule:${summary%% p*rotate*}"
  if ! grep -Eq 'USR1|HUP|reopen|reload|nginx rotate|copytruncate' <<<"$rule"; then
    cause "rotate-no-reopen: the rule for $log never signals NGINX, which keeps writing to the rotated file"
  fi
  if ! grep -Eq '(^| )(maxsize|size) ' <<<"$rule" && ((bytes * 10 / 1024 >= ${fs_size:-0})); then
    cause "log-outgrows-rotation: $log is over 10% of its filesystem between time-based rotations; add maxsize"
  fi
  if ((rotated_kb * 100 >= ${fs_size:-0} * 30 && ${fs_size:-0} > 0)); then
    cause "log-retention: rotated copies of $log take $((rotated_kb * 100 / fs_size))% of the filesystem; keep fewer, or ship them off"
  fi
  last=$(awk -v f="\"$log\"" '$1 == f {print $2}' /var/lib/logrotate/status 2>/dev/null || true)
  if [[ -n $last ]] && (($(mib "$bytes") >= min_mb)); then
    day=$(cut -d- -f1-3 <<<"$last")
    last_s=$(date -d "$day" +%s 2>/dev/null || echo "$now")
    if ((now - last_s > 2 * 86400)); then
      cause "logrotate-stale: $log was last rotated on $day and is $(mib "$bytes") MiB; check that logrotate runs and succeeds"
    fi
  fi
done
((${#logs[@]})) || echo "No NGINX log files found."
if directive error_log | grep -Eq ' (debug|info|notice)$'; then
  cause "error-log-verbose: error_log is at debug, info or notice level; warn is enough on a load balancer"
fi
if [[ -d /run/systemd/system ]]; then
  if ! systemctl is-active -q logrotate.timer; then
    cause "logrotate-inactive: logrotate.timer is not active, so no rule runs"
  elif systemctl is-failed -q logrotate.service; then
    cause "logrotate-failing: logrotate.service failed on its last run; see 'journalctl -u logrotate'"
  fi
fi
[[ -n $rules ]] || echo "No logrotate rules found."

section "Proxy cache and temp files"
# A full cache settles at max_size or at what min_free leaves, whichever is smaller.
while read -r _ path params; do
  [[ -n ${path:-} ]] || continue
  walk "$path"
  cache_kb=${kb_of[$path]}
  read -r fs_size fs_used _ < <(fs_kb "$path")
  max=$(grep -Eo 'max_size=[0-9]+[kKmMgG]?' <<<"$params" | cut -d= -f2 || true)
  min_free=$(grep -Eo 'min_free=[0-9]+[kKmMgG]?' <<<"$params" | cut -d= -f2 || true)
  zone_mb=$(grep -Eo 'keys_zone=[^:]+:[0-9]+[kKmMgG]?' <<<"$params" | cut -d: -f2 || true)
  shares=""
  if same_fs "$path" /; then shares="; it shares / with logs, temp files and the OS"; fi
  echo "cache $path: $((cache_kb / 1024)) MiB in ${files_of[$path]} files on a $((${fs_size:-0} / 1024)) MiB filesystem; $params"
  if [[ -z $max && -z $min_free ]]; then
    cause "cache-unbounded: cache $path has no max_size, holds $((cache_kb / 1024)) MiB and grows until the disk is full$shares"
  elif ((${fs_size:-0} > 0)); then
    other=$((fs_used - cache_kb))
    cap=$((fs_size - other - ${min_free:+$(size_kb "$min_free")}+0))
    if [[ -n $max ]] && (($(size_kb "$max") < cap)); then cap=$(size_kb "$max"); fi
    steady=$(((other + cap) * 100 / fs_size))
    echo "  when full, the cache holds this filesystem at about $steady%"
    if ((steady >= warn_pct)); then
      cause "cache-limit: cache $path, once full, holds its filesystem at about $steady% (max_size ${max:-unset}, min_free ${min_free:-unset}, filesystem $((fs_size / 1024)) MiB)$shares"
    fi
  fi
  if [[ -n $zone_mb && " ${inode_full[*]} " == *" $(findmnt -no TARGET --target "$path") "* ]]; then
    cause "cache-keys-exceed-inodes: keys_zone ${zone_mb} allows about $(($(size_kb "$zone_mb") * 8)) entries, more than the inodes on the cache filesystem"
  fi
done < <(directive proxy_cache_path; directive fastcgi_cache_path; directive uwsgi_cache_path; directive scgi_cache_path)
mapfile -t temp_dirs < <({
  nginx -V 2>&1 | grep -Eo -- '--http-[a-z-]+-temp-path=[^ ]+' | cut -d= -f2
  { directive proxy_temp_path; directive client_body_temp_path; directive fastcgi_temp_path; } | awk '{print $2}'
} | sort -u || true)
for dir in "${temp_dirs[@]}"; do
  [[ -d $dir ]] || continue
  walk "$dir"
  temp_kb=${kb_of[$dir]}
  on=$(findmnt -no TARGET --target "$dir" 2>/dev/null || true)
  echo "temp $dir: $((temp_kb / 1024)) MiB on ${on:-?}"
  if ((temp_kb / 1024 >= min_mb)); then
    cause "temp-files: $dir holds $((temp_kb / 1024)) MiB of buffered bodies; check proxy_max_temp_file_size and client_max_body_size"
  fi
  if [[ -n $on && " ${full[*]} " == *" $on "* && " ${causes[*]} " != *"temp-on-full-fs"* ]]; then
    cause "temp-on-full-fs: NGINX buffers to $dir on the full $on, so large request bodies and large responses to slow clients fail"
  fi
done

section "journald and syslog"
if command -v journalctl >/dev/null; then to journalctl --disk-usage 2>/dev/null || true; fi
walk /var/log/journal
journal_kb=${kb_of[/var/log/journal]:-0}
cap=$(grep -hs '^[[:space:]]*SystemMaxUse=' /etc/systemd/journald.conf /etc/systemd/journald.conf.d/*.conf | tail -1 || true)
echo "journal on disk: $((journal_kb / 1024)) MiB (/run/log/journal is in memory); ${cap:-SystemMaxUse not set (default: 10% of the filesystem, at most 4 GiB)}"
if ((journal_kb / 1024 >= big_mb)); then
  cause "journal: journald holds $((journal_kb / 1024)) MiB; 'journalctl --rotate --vacuum-size=500M', then set SystemMaxUse"
fi
syslog_kb=$(find /var/log -maxdepth 1 -name 'syslog*' -printf '%b\n' 2>/dev/null | awk '{s += $1} END {print int(s / 2)}' || true)
if ((${syslog_kb:-0} / 1024 >= big_mb)); then
  cause "syslog: /var/log/syslog* holds $((syslog_kb / 1024)) MiB; rsyslog may duplicate the journal"
fi

section "Block devices and filesystem size"
lsblk -e 1,7,43 -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS 2>/dev/null || echo "lsblk unavailable"
for mnt in / "${full[@]}"; do
  src=$(findmnt -no SOURCE --target "$mnt" 2>/dev/null || true)
  if [[ ! -b $src ]]; then
    echo "$mnt: source ${src:-unknown} is not a block device, skipped"
    continue
  fi
  dev_b=$(lsblk -bdno SIZE "$src" 2>/dev/null || echo 0)
  fs_b=$(fs_kb "$mnt" | awk '{print $1 * 1024}')
  echo "$mnt: filesystem $((fs_b >> 20)) MiB on $src of $((dev_b >> 20)) MiB"
  if ((dev_b - fs_b > gib / 8 && (dev_b - fs_b) * 10 > dev_b)); then
    cause "fs-not-grown: $mnt is $((fs_b >> 20)) MiB on a $((dev_b >> 20)) MiB device; resize2fs or xfs_growfs"
  fi
  disk=$(lsblk -snro NAME,TYPE "$src" 2>/dev/null | awk '$2 == "disk" {print $1; exit}' || true)
  if [[ -n $disk ]]; then
    disk_b=$(lsblk -bdno SIZE "/dev/$disk" 2>/dev/null || echo 0)
    parts_b=$(lsblk -bnro SIZE,TYPE "/dev/$disk" 2>/dev/null | awk '$2 == "part" {s += $1} END {print s + 0}' || true)
    if ((parts_b > 0 && disk_b - parts_b > gib)); then
      cause "disk-unallocated: /dev/$disk has $(((disk_b - parts_b) >> 30)) GiB outside any partition; growpart, then grow the filesystem"
    fi
  fi
  if [[ $(lsblk -dno TYPE "$src" 2>/dev/null || true) == lvm ]] && command -v vgs >/dev/null; then
    vg=$(to lvs --noheadings -o vg_name "$src" 2>/dev/null | tr -d ' ' || true)
    vg_free=$(to vgs --noheadings --units b --nosuffix -o vg_free "$vg" 2>/dev/null | tr -d ' ' || true)
    echo "  LVM: volume group ${vg:-?} has $((${vg_free:-0} >> 20)) MiB unallocated"
    if ((${vg_free:-0} > gib / 8)); then
      cause "lvm-free: volume group $vg has $((vg_free >> 20)) MiB unallocated; grow by what is needed, e.g. 'lvextend -r -L +10G $src', as ext4 cannot shrink online"
    fi
  fi
  if command -v tune2fs >/dev/null && [[ $(findmnt -no FSTYPE --target "$mnt") == ext4 ]]; then
    tune2fs -l "$src" 2>/dev/null | awk -F: '/^Reserved block count|^Block size/ {gsub(/ /, "", $2); v[$1] = $2}
      END {printf "  ext4 reserve for root: %d MiB\n", v["Reserved block count"] * v["Block size"] / 1048576}' || true
  fi
done

section "Growth during this run"
((SECONDS - start_s >= sample_s)) || sleep $((sample_s - (SECONDS - start_s)))
elapsed=$((SECONDS - start_s))
((elapsed > 0)) || elapsed=1
for mnt in "${checked[@]}"; do
  read -r _ used avail < <(fs_kb "$mnt")
  grew=$((used - ${used0[$mnt]:-$used}))
  if ((grew > 0)); then
    hours=$((avail / (grew * 3600 / elapsed + 1)))
    echo "$mnt: grew $grew KiB in ${elapsed} s, so full in about $hours h"
    ((hours >= 24)) || cause "growing: $mnt is full in about $hours h at the current rate; 'find $mnt -xdev -mmin -5 -size +10M' finds the writer"
  else
    echo "$mnt: no growth in ${elapsed} s"
    if ((avail > 0)) && [[ " ${byte_full[*]} " == *" $mnt "* ]]; then
      notes+=("$mnt did not grow during the sample. If it stays this full for hours, something holds it at a limit: a cache max_size or min_free, or log retention sized to the disk")
    fi
  fi
done
for log in "${!log_bytes0[@]}"; do
  bytes=$(stat -c %s "$log" 2>/dev/null) || continue
  grew=$((bytes - ${log_bytes0[$log]}))
  ((grew > 0)) || continue
  rate_mb=$((grew * 3600 / elapsed >> 20))
  echo "$log: grew $grew bytes, about $rate_mb MiB/h"
  on=$(findmnt -no TARGET --target "$log" 2>/dev/null || true)
  if ((rate_mb >= 100)) && [[ " ${full[*]} " == *" $on "* ]]; then
    cause "log-flood: $log grows $rate_mb MiB/h on the full $on; check for a traffic flood, then buffer, sample or filter access logging"
  fi
done

section "Likely causes"
if ((${#causes[@]})); then
  printf -- '- %s\n' "${causes[@]}"
else
  echo "- none of the known causes matched; start from the largest directories above"
fi
((${#notes[@]} == 0)) || printf 'Note: %s\n' "${notes[@]}"
