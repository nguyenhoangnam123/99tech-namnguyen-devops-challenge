#!/usr/bin/env bash
# Read-only disk triage for an NGINX host: it never deletes, moves or truncates.
# Usage: sudo triage.sh   Tune with WARN_PCT (default 90), MIN_MB (10), BIG_MB (1024).
set -euo pipefail

warn_pct=${WARN_PCT:-90}
min_mb=${MIN_MB:-10}
big_mb=${BIG_MB:-1024}
gib=$((1 << 30))
causes=()

section() { printf '\n== %s\n' "$1"; }
cause() { causes+=("$1"); }
mib() { echo $((($1 + 1048575) / 1048576)); }
kib_of() { du -sxk "$1" 2>/dev/null | awk '{print $1}' || true; }

# Idle IO priority, so du does not compete with the proxy for the disk.
low=(nice -n 19)
if command -v ionice >/dev/null && ionice -c3 true 2>/dev/null; then low+=(ionice -c3); fi

# Reads the config with its includes. 'nginx -T' would open, and so create, log files.
read_conf() {
  local file line inc
  for file in "$@"; do
    [[ -f $file ]] || continue
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line =~ ^[[:space:]]*include[[:space:]]+([^;]+)\; ]]; then
        inc=${BASH_REMATCH[1]}
        [[ $inc == /* ]] || inc=/etc/nginx/$inc
        # shellcheck disable=SC2086 # include paths are globs
        read_conf $inc
      else
        printf '%s\n' "$line"
      fi
    done <"$file"
  done
}
nginx_conf=$(read_conf /etc/nginx/nginx.conf | sed 's/#.*//')
directive() { awk -v d="$1" '$1 == d { sub(/;[[:space:]]*$/, ""); print }' <<<"$nginx_conf"; }

echo "Disk triage on $(hostname) at $(date -u +%FT%TZ); kernel $(uname -r)"
[[ $EUID -eq 0 ]] || echo "warning: not root, so other users' open files and some directories are hidden"

section "Filesystems (bytes and inodes)"
df -hT -x squashfs -x devtmpfs -x efivarfs 2>/dev/null || true
full=()
while read -r _ _ size used _ pct mnt; do
  pct=${pct%\%}
  if [[ ! $pct =~ ^[0-9]+$ ]] || ((pct < warn_pct)); then continue; fi
  full+=("$mnt")
  echo "FULL bytes: $mnt at $pct% ($((used / 1024)) of $((size / 1024)) MiB)"
done < <(df -PT -x squashfs -x devtmpfs -x efivarfs 2>/dev/null | tail -n +2)
while read -r _ inodes iused _ pct mnt; do
  pct=${pct%\%}
  if [[ ! $pct =~ ^[0-9]+$ ]] || ((pct < warn_pct)); then continue; fi
  [[ " ${full[*]} " == *" $mnt "* ]] || full+=("$mnt")
  echo "FULL inodes: $mnt at $pct% ($iused of $inodes); files per directory:"
  depth=$(awk -F/ '{print NF + 1}' <<<"$mnt")
  "${low[@]}" find "$mnt" -xdev -type f 2>/dev/null | cut -d/ -f1-"$depth" | sort | uniq -c |
    sort -rn | head -5 || true
  cause "inodes: $mnt has used $pct% of its inodes ($iused files and directories); bytes are not the limit"
done < <(df -Pi -x squashfs -x devtmpfs -x efivarfs 2>/dev/null | tail -n +2)
((${#full[@]})) || echo "No filesystem at or above $warn_pct% of its bytes or inodes."

# df counts blocks still held by open files; du only sees names in the tree.
section "Space df counts but du cannot see"
for mnt in "${full[@]:-/}"; do
  if [[ $(df -PT "$mnt" | awk 'NR == 2 {print $2}') == overlay ]]; then
    echo "$mnt: overlay filesystem, its lower layers are outside du's view; skipped"
    continue
  fi
  used_kb=$(df -Pk "$mnt" | awk 'NR == 2 {print $3}')
  du_kb=$("${low[@]}" du -sxk "$mnt" 2>/dev/null | awk '{print $1}' || true)
  gap_mb=$(((used_kb - ${du_kb:-0}) / 1024))
  echo "$mnt: df used $((used_kb / 1024)) MiB, du sees $((${du_kb:-0} / 1024)) MiB, gap $gap_mb MiB"
  ((gap_mb < min_mb)) || echo "  The gap is deleted files still held open, or files hidden under a mount point."
done

section "Deleted files still held open"
declare -A size_of name_of holders
for fd in /proc/[0-9]*/fd/*; do
  target=$(readlink "$fd" 2>/dev/null) || continue
  [[ $target == /*' (deleted)' && $target != /dev/* && $target != /memfd:* ]] || continue
  id=$(stat -L -c '%d:%i' "$fd" 2>/dev/null) || continue
  pid=${fd#/proc/}
  pid=${pid%%/*}
  size_of[$id]=$(stat -L -c %s "$fd" 2>/dev/null || echo 0)
  name_of[$id]=${target% (deleted)}
  holders[$id]+="$(cat "/proc/$pid/comm" 2>/dev/null) $pid fd ${fd##*/}, "
done
deleted_total=0
biggest=""
for id in "${!size_of[@]}"; do
  deleted_total=$((deleted_total + size_of[$id]))
  if [[ -z $biggest ]] || ((size_of[$id] > size_of[$biggest])); then biggest=$id; fi
done
for id in "${!size_of[@]}"; do
  printf '%10s MiB  %s  held by %s\n' "$(mib "${size_of[$id]}")" "${name_of[$id]}" "${holders[$id]%, }"
done | sort -rn | head -10
if [[ -z $biggest ]]; then
  echo "None."
elif (($(mib "$deleted_total") >= min_mb)); then
  read -r comm pid _ fdnum <<<"${holders[$biggest]%%,*}"
  cause "deleted-open: $(mib "$deleted_total") MiB in deleted files still open, mostly ${name_of[$biggest]} ($comm $pid). Free it with 'nginx -s reopen' for NGINX logs, or ': > /proc/$pid/fd/$fdnum'"
fi

section "Largest directories"
for mnt in "${full[@]:-/}"; do
  echo "on $mnt:"
  "${low[@]}" du -xk --max-depth=2 "$mnt" 2>/dev/null | sort -rn | head -10 |
    awk '{printf "%10.1f MiB  %s\n", $1 / 1024, $2}' || true
done

section "Usual suspects"
for dir in /var/log /var/log/nginx /var/log/journal /var/cache/nginx /var/lib/nginx \
  /var/cache/apt/archives /var/crash /var/lib/snapd/snaps /tmp /var/tmp /boot; do
  [[ -d $dir ]] || continue
  kb=$(kib_of "$dir")
  printf '%10s MiB  %s\n' "$((${kb:-0} / 1024))" "$dir"
done
crash_kb=$(kib_of /var/crash)
if ((${crash_kb:-0} / 1024 >= min_mb)); then
  cause "crash-dumps: /var/crash holds $((crash_kb / 1024)) MiB; copy them off, then remove them"
fi
apt_kb=$(kib_of /var/cache/apt/archives)
if ((${apt_kb:-0} / 1024 >= big_mb / 4)); then
  cause "apt-cache: $((apt_kb / 1024)) MiB of downloaded packages; 'apt-get clean' is safe"
fi
kernels=$(find /boot -maxdepth 1 -name 'vmlinuz-*' 2>/dev/null | wc -l || true)
if ((kernels > 2)); then
  cause "old-kernels: $kernels kernels in /boot; 'apt autoremove --purge' keeps the running one"
fi
if command -v snap >/dev/null; then
  disabled=$(snap list --all 2>/dev/null | awk '/disabled/' | wc -l || true)
  ((disabled == 0)) || cause "snap-revisions: $disabled disabled snap revisions; 'snap set system refresh.retain=2'"
fi

section "NGINX logs and rotation"
# One line per logrotate rule: its path patterns, a tab, then its directives.
rules=$(cat /etc/logrotate.conf /etc/logrotate.d/* 2>/dev/null | sed 's/#.*//' | awk '
  { for (i = 1; i <= NF; i++) {
      t = $i
      if (skip) { skip = 0; continue }
      if (t == "{") { depth++; body = "" }
      else if (t == "}") { depth--; if (depth == 0) { print pats "\t" body; pats = "" } }
      else if (depth == 0 && t == "include") skip = 1
      else if (depth == 0 && t ~ /^"?\//) { gsub(/"/, "", t); pats = pats " " t }
      else if (depth == 1) body = body " " t
  } }' || true)
mapfile -t logs < <({
  { directive access_log; directive error_log; } | awk '$2 ~ /^\// && $2 !~ /^\/dev\// {print $2}'
  for log in /var/log/nginx/*.log; do [[ -e $log ]] && echo "$log"; done
} | sort -u)
for log in "${logs[@]}"; do
  [[ -e $log ]] || continue
  bytes=$(stat -c %s "$log")
  rotated_kb=$(find "$(dirname "$log")" -maxdepth 1 -name "$(basename "$log")?*" -printf '%k\n' 2>/dev/null |
    awk '{s += $1} END {print s + 0}' || true)
  rule=""
  while IFS=$'\t' read -r pats body; do
    read -ra patterns <<<"$pats"
    for pat in "${patterns[@]}"; do
      # shellcheck disable=SC2053 # the right side is a logrotate glob on purpose
      if [[ $log == $pat ]]; then rule=${body:- (empty)} && break 2; fi
    done
  done <<<"$rules"
  if [[ -z $rule ]]; then
    echo "$log: $(mib "$bytes") MiB, rotated copies $((rotated_kb / 1024)) MiB, NOT covered by logrotate"
    if (($(mib "$bytes") >= min_mb)); then
      cause "log-not-rotated: $log is $(mib "$bytes") MiB and no logrotate rule matches it"
    fi
    continue
  fi
  summary=${rule%% sharedscripts*}
  echo "$log: $(mib "$bytes") MiB, rotated copies $((rotated_kb / 1024)) MiB; rule:${summary%% p*rotate*}"
  if ! grep -Eq 'USR1|reopen|nginx rotate|copytruncate' <<<"$rule"; then
    cause "rotate-no-reopen: the rule for $log never signals NGINX, which keeps writing to the rotated file"
  fi
  fs_kb=$(df -Pk "$log" | awk 'NR == 2 {print $2}')
  if ! grep -Eq '(^| )(maxsize|size) ' <<<"$rule" && ((bytes * 10 / 1024 >= fs_kb)); then
    cause "log-outgrows-rotation: $log is over 10% of its filesystem between time-based rotations; add maxsize"
  fi
done
((${#logs[@]})) || echo "No NGINX log files found."
if directive error_log | grep -Eq '[[:space:]](debug|info|notice)$'; then
  cause "error-log-verbose: error_log is at debug, info or notice level; warn is enough on a load balancer"
fi
if [[ -d /run/systemd/system ]] && ! systemctl is-active -q logrotate.timer; then
  cause "logrotate-inactive: logrotate.timer is not active, so no rule runs"
fi
[[ -n $rules ]] || echo "No logrotate rules found."

section "Proxy cache and temp files"
while read -r _ path params; do
  [[ -n ${path:-} ]] || continue
  kb=$(kib_of "$path")
  files=$(find "$path" -xdev -type f 2>/dev/null | wc -l || true)
  echo "cache $path: $((${kb:-0} / 1024)) MiB in $files files; $params"
  if [[ $params != *max_size=* ]]; then
    cause "cache-unbounded: cache $path has no max_size, holds $((${kb:-0} / 1024)) MiB and grows until the disk is full"
  fi
done < <(directive proxy_cache_path; directive fastcgi_cache_path)
temp_dirs=$({
  nginx -V 2>&1 | grep -Eo -- '--http-[a-z-]+-temp-path=[^ ]+' | cut -d= -f2
  { directive proxy_temp_path; directive client_body_temp_path; } | awk '{print $2}'
} | sort -u || true)
for dir in $temp_dirs; do
  [[ -d $dir ]] || continue
  kb=$(kib_of "$dir")
  echo "temp $dir: $((${kb:-0} / 1024)) MiB"
  if ((${kb:-0} / 1024 >= min_mb)); then
    cause "temp-files: $dir holds $((kb / 1024)) MiB of buffered bodies; check proxy_max_temp_file_size and client_max_body_size"
  fi
done

section "journald and syslog"
if command -v journalctl >/dev/null; then journalctl --disk-usage 2>/dev/null || true; fi
journal_kb=$(du -sck /var/log/journal /run/log/journal 2>/dev/null | awk 'END {print $1 + 0}' || true)
cap=$(grep -hs '^[[:space:]]*SystemMaxUse=' /etc/systemd/journald.conf /etc/systemd/journald.conf.d/*.conf | tail -1 || true)
echo "journal on disk: $((journal_kb / 1024)) MiB; ${cap:-SystemMaxUse not set (default: 10% of the filesystem, at most 4 GiB)}"
if ((journal_kb / 1024 >= big_mb)); then
  cause "journal: journald holds $((journal_kb / 1024)) MiB; 'journalctl --vacuum-size=500M', then set SystemMaxUse"
fi
syslog_kb=$(du -sck /var/log/syslog* 2>/dev/null | awk 'END {print $1 + 0}' || true)
if ((syslog_kb / 1024 >= big_mb)); then
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
  dev_b=$(lsblk -bdno SIZE "$src" || echo 0)
  fs_b=$(df -PB1 "$mnt" | awk 'NR == 2 {print $2}')
  echo "$mnt: filesystem $((fs_b >> 20)) MiB on $src of $((dev_b >> 20)) MiB"
  if ((dev_b - fs_b > gib / 8 && (dev_b - fs_b) * 10 > dev_b)); then
    cause "fs-not-grown: $mnt is $((fs_b >> 20)) MiB on a $((dev_b >> 20)) MiB device; resize2fs or xfs_growfs"
  fi
  disk=$(lsblk -snro NAME,TYPE "$src" 2>/dev/null | awk '$2 == "disk" {print $1; exit}' || true)
  if [[ -n $disk ]]; then
    disk_b=$(lsblk -bdno SIZE "/dev/$disk" || echo 0)
    parts_b=$(lsblk -bnro SIZE,TYPE "/dev/$disk" | awk '$2 == "part" {s += $1} END {print s + 0}' || true)
    if ((parts_b > 0 && disk_b - parts_b > gib)); then
      cause "disk-unallocated: /dev/$disk has $(((disk_b - parts_b) >> 30)) GiB outside any partition; growpart, then grow the filesystem"
    fi
  fi
  if [[ $(lsblk -dno TYPE "$src") == lvm ]] && command -v vgs >/dev/null; then
    vg=$(lvs --noheadings -o vg_name "$src" 2>/dev/null | tr -d ' ')
    vg_free=$(vgs --noheadings --units b --nosuffix -o vg_free "$vg" 2>/dev/null | tr -d ' ')
    echo "  LVM: volume group $vg has $((${vg_free:-0} >> 20)) MiB unallocated"
    if ((${vg_free:-0} > gib / 8)); then
      cause "lvm-free: volume group $vg has $((vg_free >> 20)) MiB unallocated; lvextend -r -l +100%FREE $src"
    fi
  fi
  if command -v tune2fs >/dev/null && [[ $(findmnt -no FSTYPE --target "$mnt") == ext4 ]]; then
    tune2fs -l "$src" 2>/dev/null | awk -F: '/^Reserved block count|^Block size/ {gsub(/ /, "", $2); v[$1] = $2}
      END {printf "  ext4 reserve for root: %d MiB\n", v["Reserved block count"] * v["Block size"] / 1048576}' || true
  fi
done

section "Likely causes"
if ((${#causes[@]})); then
  printf -- '- %s\n' "${causes[@]}"
else
  echo "- none of the known causes matched; start from the largest directories above"
fi
