# Problem 2: an NGINX load balancer at 99% disk

The disk is nearly full on an Ubuntu 24.04 VM that runs only NGINX as a load balancer.

My approach:

1. Find what holds the space before deleting anything.
2. Free it without restarting NGINX.
3. Fix whatever let it grow.

The triage is scripted, read-only and tested. [scripts/triage.sh](scripts/triage.sh) checks
every cause below. A [lab](lab/RESULTS.md) reproduces five of them in containers. For each
one it checks that the script names the cause, that the recovery works while traffic flows,
and what clients see in the meantime.

## Assumptions

| Unknown                                                  | Assumption                                                                                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The brief says "two production issues" but describes one | I answer the one described: the full disk, and what it does to traffic                                                                                                      |
| How the VM was installed                                 | Either a cloud image (root on a plain partition, grown by cloud-init at first boot) or Ubuntu Server's guided LVM layout. That layout gives root about half of a 64 GB disk |
| How NGINX is set up                                      | Ubuntu's package: logs in `/var/log/nginx`, rotated daily and kept 14 times, temp files in `/var/lib/nginx`, workers run as `www-data`                                      |
| "Only runs NGINX"                                        | A claim to check. journald, apt, snapd and crash reporting also write to this disk                                                                                          |
| Monitoring                                               | A percent-used alert on `/`, with no inode or growth-rate alert                                                                                                             |
| Access                                                   | sudo over SSH or SSM. The VM serves live traffic, so reload and reopen are fine, a restart is a last resort                                                                 |

## 1. The first five minutes: look, don't delete

All read-only. `sudo triage.sh` runs every check below in one go, at idle IO priority, and
ends with a list of likely causes.

| #   | Command                                                                  | What it answers                                                                                                               |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | `df -hT` and `df -i`                                                     | Which filesystem is full, and whether bytes or inodes ran out                                                                 |
| 2   | `df` twice, minutes apart, or the monitoring graph                       | How fast it grows: hours to 100% means act now, days means fix it properly                                                    |
| 3   | `sudo du -xh --max-depth=2 / \| sort -rh \| head -20`                    | Where the bytes are; `-x` stays on one filesystem                                                                             |
| 4   | Compare `df` used with the `du` total                                    | A large gap means deleted files are still held open: `sudo find /proc/*/fd -lname '*(deleted)' -printf '%l\n'`, or `lsof +L1` |
| 5   | `lsblk`, `sudo vgs`, `sudo lvs`                                          | Whether the filesystem is as big as the disk                                                                                  |
| 6   | `ls -lah /var/log/nginx`, `sudo tail -50 /var/log/nginx/error.log`       | Log sizes, and whether an upstream failure is flooding the error log                                                          |
| 7   | `grep -rE 'cache_path\|error_log' /etc/nginx`, `journalctl --disk-usage` | Cache limits, log level, journal size                                                                                         |

## 2. From symptom to cause

| What you see                                                      | Likely cause                                                          | Confirm with                                                                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `df` and `du` agree; `/var/log` is large                          | Logs not rotated, rotated too slowly, or kept too long                | `logrotate -d /etc/logrotate.d/nginx`, `/var/lib/logrotate/status`, `systemctl status logrotate.timer` |
| `df` is far above the `du` total                                  | Deleted files still held open                                         | `/proc/*/fd` entries marked `(deleted)`                                                                |
| `df -h` shows room but writes fail with "No space left on device" | Inodes exhausted                                                      | `df -i`, then files per directory                                                                      |
| `df` shows about 31 GB on a 64 GB disk                            | Disk space outside the filesystem                                     | `lsblk`, `vgs` free space                                                                              |
| `/var/cache/nginx` or `/var/lib/nginx` is large                   | Unbounded proxy cache, or temp files from large bodies                | `max_size` in `proxy_cache_path`                                                                       |
| `/var/log/journal` or `/var/log/syslog` is large                  | journald, or rsyslog keeping a second copy                            | `journalctl --disk-usage`                                                                              |
| `/var/crash`, `/boot`, `/var/lib/snapd`, `/var/cache/apt`         | Crash dumps, old kernels, snap revisions, package cache               | `du` of each                                                                                           |
| No gap, nothing large, yet `df` is full                           | Files written under a directory before another disk was mounted on it | `mount --bind / /mnt/root`, then `du` there                                                            |

## 3. Causes: impact, recovery, prevention

Recovery steps are safe while serving. "Lab" marks the ones reproduced, with what clients
saw while the disk was full.

| Cause                                                                                                                                 | Impact on the load balancer                                                                                                                                                      | Recovery                                                                                                                                                       | Prevention                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Logs not rotated:** a path outside `/var/log/nginx`, a stopped `logrotate.timer`, or daily rotation that traffic outgrows           | Traffic keeps flowing (lab: 100 of 100 requests 200 at 100% full). New log lines are lost, so the evidence for the next incident is gone, and certificate renewals and apt fail. | `mv` the file aside, `nginx -s reopen`, copy it off the full disk, then delete it. Or `truncate -s 0` if the log can be lost. (lab)                            | A rule per log path with `maxsize`, an hourly timer, and a `postrotate` reopen. Ship logs off the box.                                                              |
| **Deleted but still open:** someone ran `rm` on a live log, or a rotation never told NGINX to reopen                                  | The `rm` frees nothing, and `du` cannot see the space, so people waste time searching                                                                                            | `nginx -s reopen` (lab: 100% to 0% at once). For other processes, `: > /proc/PID/fd/N`                                                                         | Never `rm` a live log. Rotate only through logrotate with a reopen                                                                                                  |
| **Error log flood:** upstream down, or `debug` level left on                                                                          | The flood is a symptom: an upstream is failing. The disk then fills in hours                                                                                                     | Fix the upstream. Set `error_log ... warn;` and `nginx -s reload`, then rotate                                                                                 | `warn` level. Alert on the upstream error rate, not just disk                                                                                                       |
| **Proxy cache without `max_size`**                                                                                                    | Lab: every new 1 MiB response was a **200 with a truncated body**. Clients think it worked                                                                                       | Add `max_size` (and `min_free`) and reload. The cache manager evicts (lab: 99% to 49% in seconds). Deleting cache files is also safe: a missing file is a miss | `max_size` well below the volume size. In the lab, a burst of 100 new objects overshot it (88 truncated) before eviction caught up. Put the cache on its own volume |
| **Inodes exhausted:** millions of small cache or temp files                                                                           | Lab: bytes 10% used, yet **every new request got no reply**, because NGINX could not create a cache file. Cached URLs still worked                                               | Delete the cache files, or whatever directory `find -xdev -type f` counts most files in                                                                        | Size `keys_zone` to cap entries (1 MB holds about 8,000 keys) below the volume's inode count. Alert on inodes                                                       |
| **Temp files:** large uploads or responses buffered to `/var/lib/nginx`                                                               | Large uploads fail and large responses are cut short; small requests still work. Files normally go when the request ends                                                         | Leftovers from killed workers: remove files older than an hour                                                                                                 | `proxy_max_temp_file_size`, `client_max_body_size`, `proxy_request_buffering off` for uploads                                                                       |
| **Disk not in the filesystem:** guided LVM left half the disk free, or the disk was resized but the partition and filesystem were not | The filesystem is 31 GB, not 64 GB. 99% of it is the real limit, and the space is already paid for                                                                               | `sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv`, online (lab: 100% to 24%). If the disk was resized, first `growpart` and `pvresize`                  | Check at build time that the root filesystem fills the disk                                                                                                         |
| **journald and rsyslog:** persistent journal (10% of the filesystem, at most 4 GiB) plus `/var/log/syslog`                            | Rarely the whole story, but often several GB                                                                                                                                     | `journalctl --vacuum-size=500M`                                                                                                                                | `SystemMaxUse=1G`. Ship logs instead of keeping two local copies                                                                                                    |
| **Other writers:** crash dumps, old kernels filling `/boot`, snap revisions, apt cache, a forgotten `tcpdump`                         | `/boot` full blocks security updates                                                                                                                                             | Copy crash dumps off the box, then: `apt autoremove --purge`, `apt-get clean`, `snap set system refresh.retain=2`                                              | The growth-rate alert below                                                                                                                                         |

Not reproduced in the lab: the error-log flood, temp files, journald, the other writers, and
files hidden under a mount point. The script checks them all, but only the five lab cases
are tested end to end.

## 4. If it is at 100% right now

1. **Check traffic first.** Look at the 5xx rate and `curl` through the load balancer. The
   lab shows that full logs leave traffic alone, while a full cache volume breaks responses.
   That tells you how fast to move.
2. **Stop the growth.** Find the file growing fastest with
   `sudo find / -xdev -mmin -10 -size +100M`. If the error log is flooding, set
   `error_log ... warn;` and `nginx -s reload`.
3. **Free space without a restart:**

   | What holds the space                | Action                                                                |
   | ----------------------------------- | --------------------------------------------------------------------- |
   | Deleted files NGINX still holds     | `nginx -s reopen`                                                     |
   | Deleted files another process holds | `: > /proc/PID/fd/N`                                                  |
   | A live log you can lose             | `truncate -s 0`, never `rm`                                           |
   | A live log you must keep            | `mv` it aside, `nginx -s reopen`, copy it off the box, then delete it |
   | System leftovers                    | `journalctl --vacuum-size=500M`; `apt-get clean`                      |
   | Cache entries                       | Delete them; NGINX treats them as misses                              |

4. **Emergency headroom.** ext4 keeps 5% of the filesystem for root, up to 3.2 GB here.
   `tune2fs -m 1 /dev/<root>` releases most of it, and `tune2fs -m 5` puts it back once
   the fix is in.
5. **The fix.** Grow the volume online, or add the missing rotation or cache limit.

Avoid three things on a live load balancer:

- `rm` on an open file;
- restarting NGINX when `reopen` or `reload` will do;
- emptying `/var/lib/nginx` while requests are using its temp files.

## 5. Prevention

| Control                            | Setting                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Rotate by size as well as time     | `maxsize 1G`, `rotate 7`, `compress`, `postrotate` with `nginx -s reopen` (Ubuntu's rule already reopens); `logrotate.timer` hourly       |
| Logs off the box                   | CloudWatch agent or Vector to central storage; keep a day or two locally                                                                  |
| Bounded cache                      | `max_size` at about 70% of a dedicated volume, plus `min_free`, `keys_zone` sized for the inode count, `use_temp_path=off`                |
| Separate volumes                   | `/var/log` and `/var/cache/nginx` on their own volumes, so they cannot fill root and take SSH, apt and certificate renewal down with them |
| Bounded journal                    | `SystemMaxUse=1G` in `/etc/systemd/journald.conf.d/`                                                                                      |
| Alert on time to full, not percent | `predict_linear(node_filesystem_avail_bytes[6h], 4*3600) < 0` pages; a 3-day horizon opens a ticket                                       |
| Alert on inodes                    | `node_filesystem_files_free / node_filesystem_files < 0.10`                                                                               |
| Check at build time                | The root filesystem fills the disk (`lsblk` against `df`), and every `access_log` path has a logrotate rule                               |

## 6. The bigger risk

One VM routes all upstream traffic. A full disk is one way it fails; kernel patching, a
host failure or a zone outage are others. Disk space is the symptom, and the single load
balancer is the risk.

- **On AWS:** an ALB or NLB has no disk to fill, spans zones, and writes its access logs
  to S3. Problems 1 and 4 use an ALB.
- **When NGINX must stay** for caching or rewrites the cloud load balancer cannot do: run
  two or more instances behind an NLB.
- **Outside a cloud:** run a pair with keepalived and a floating IP.

## Running it

```sh
# On the VM. Read-only; WARN_PCT and MIN_MB tune what counts as a finding.
sudo bash triage.sh

# The lab: Docker only, removes its containers and image afterwards.
src/problem2/lab/run.sh
# The LVM case needs a privileged container for the loop device.
src/problem2/lab/run.sh lvm-free
```
