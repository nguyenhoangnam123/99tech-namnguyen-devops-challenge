# Problem 2: an NGINX load balancer at 99% disk

The disk sits at 99% on an Ubuntu 24.04 VM that runs only NGINX as a load balancer.

My approach:

1. Find what holds the space before deleting anything.
2. Free it without restarting NGINX.
3. Fix whatever let it grow.

The triage is scripted, read-only and tested. [scripts/triage.sh](scripts/triage.sh) checks
every cause below. A [lab](lab/RESULTS.md) reproduces six of them, plus a config parsing
check. CI runs all but the LVM case, which needs a privileged container. For each case it records:

- what clients saw while the disk was full: small requests, 64 KiB uploads and 1 MiB
  downloads to a slow client;
- that the script names the cause;
- that recovery frees the space without restarting NGINX, while a stream of live requests
  keeps being served.

## Assumptions

| Unknown                                                  | Assumption                                                                                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The brief says "two production issues" but describes one | I answer the one described: the full disk, and what it does to traffic                                                                                                      |
| "Consistently at 99%"                                    | A flat line, not a climb. That points first at something held at a limit, such as a cache or log retention sized to the disk. A growing cause would reach 100%              |
| How the VM was installed                                 | Either a cloud image (root on a plain partition, grown by cloud-init at first boot) or Ubuntu Server's guided LVM layout. That layout gives root about half of a 64 GB disk |
| How NGINX is set up                                      | Ubuntu's package: logs in `/var/log/nginx`, rotated daily and kept 14 times. Request and response buffers spill to `/var/lib/nginx`, on the same root filesystem            |
| "Only runs NGINX"                                        | A claim to check. journald, apt, snapd, crash reporting, a log shipper or Docker also write to this disk                                                                    |
| Monitoring                                               | A percent-used alert on `/`, with no inode or growth-rate alert                                                                                                             |
| Access                                                   | sudo over SSH or SSM. The VM serves live traffic, so reload and reopen are fine; a restart is a last resort                                                                 |

## 1. The first five minutes: look, don't delete

All of this is read-only. `sudo triage.sh` runs every check below in one go and ends with a
list of likely causes. It runs niced (`ionice` idle class too, where the IO scheduler
honours it), uses a timeout on anything that can hang, and keeps its own temp files in
memory.

| #   | Command                                                                  | What it answers                                                                                                          |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | `df -hTl` and `df -il`                                                   | Which local filesystem is full, and whether bytes or inodes ran out                                                      |
| 2   | `df` twice, minutes apart, or the monitoring graph                       | Growing or flat. Hours to 100% means act now. A flat line means something holds it at a limit                            |
| 3   | `sudo du -xh --max-depth=2 / \| sort -rh \| head -20`                    | Where the bytes are; `-x` stays on one filesystem                                                                        |
| 4   | Compare `df` used with the `du` total                                    | A large gap means deleted files are still held open: `sudo find /proc/[0-9]*/fd -lname '/* (deleted)' -printf '%p %l\n'` |
| 5   | `lsblk`, `sudo vgs`, `sudo lvs`                                          | Whether the filesystem is as big as the disk                                                                             |
| 6   | `ls -lah /var/log/nginx`, `sudo tail -50 /var/log/nginx/error.log`       | Log sizes, and whether an upstream failure is flooding the error log                                                     |
| 7   | `grep -rE 'cache_path\|error_log' /etc/nginx`, `journalctl --disk-usage` | Cache limits, log level, journal size                                                                                    |

## 2. From symptom to cause

| What you see                                                                                     | Likely cause                                                                             | Confirm with                                                                                  |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Flat at 99% for days; `/var/cache/nginx` is most of the disk                                     | Cache `max_size` or `min_free` sized to the volume, or sharing `/`                       | `max_size` and `min_free` against `df` of the cache path                                      |
| Flat with a daily sawtooth; `/var/log/nginx` holds many rotated files                            | Retention sized to the disk                                                              | `rotate` count times the daily volume                                                         |
| Growing; `/var/log` is large and `df` agrees with `du`                                           | Logs not rotated, or rotated too slowly                                                  | `logrotate -d`, `systemctl is-failed logrotate.service`, dates in `/var/lib/logrotate/status` |
| `df` is far above the `du` total                                                                 | Deleted files still held open, by NGINX or by a log shipper                              | `/proc/*/fd` entries marked `(deleted)`                                                       |
| `df -h` shows room but writes fail with "No space left on device"                                | Inodes exhausted                                                                         | `df -i`, then entries per directory                                                           |
| `df` shows about 31 GB on a 64 GB disk                                                           | Disk space outside the filesystem                                                        | `lsblk`, `vgs` free space                                                                     |
| `/var/lib/docker` is large                                                                       | NGINX in Docker, with json-file logs and no `max-size`                                   | `/etc/docker/daemon.json`                                                                     |
| `/var/log/journal`, `/var/log/syslog`, `/var/crash`, `/boot`, `/var/lib/snapd`, `/var/cache/apt` | journald, rsyslog's second copy, crash dumps, old kernels, snap revisions, package cache | `du` of each                                                                                  |
| No gap, nothing large, yet `df` is full                                                          | Files written under a directory before another disk was mounted on it                    | `mount --bind / /mnt/root`, then `du` there                                                   |

## 3. What a full disk does to traffic

Measured in the lab with the disk 100% full. Clients sent 100 small GETs, 20 POSTs of
64 KiB, and 5 downloads of 1 MiB at 512 KiB/s.

| Full filesystem                                                   | Small GETs                  | 64 KiB POSTs              | 1 MiB to a slow client                        | Access log                                                             |
| ----------------------------------------------------------------- | --------------------------- | ------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| The one holding logs and `/var/lib/nginx`, as `/` does on this VM | 100 of 100 OK               | **20 of 20 returned 500** | **5 of 5 returned 200 with a truncated body** | **New lines lost; the error log could not record the failures either** |
| A cache volume out of inodes                                      | **100 of 100 got no reply** | 20 of 20 OK               | **5 of 5 got no reply**                       | Written                                                                |
| A cache volume out of bytes                                       | 100 of 100 OK               | 20 of 20 OK               | **5 of 5 returned 200 with a truncated body** | Written                                                                |

So the impact depends on where the space runs out, not on what used it.

- **Any cause that fills `/` hurts traffic beyond logging.** NGINX buffers request bodies
  over `client_body_buffer_size`, and responses a client reads slower than the upstream
  sends, to `/var/lib/nginx` on the same filesystem. That covers logs, a cache on `/`,
  journald and the other writers alike.
- **The failures hide from status-code monitoring.** A truncated 200 counts as a success,
  and a dropped connection has no status at all. Only a client that checks
  `Content-Length` sees the short body; curl and Chrome do.

## 4. Causes: impact, recovery, prevention

"Lab" marks the cases reproduced. Recovery is safe while serving. In the lab, live requests
ran through every recovery: none failed, except on the inode case, where the requests sent
before the cache was cleared got no reply.

| Cause                                                                                                                                                         | Impact beyond section 3                                                                                                                                                    | Recovery                                                                                                                                                                                                                               | Prevention                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cache limit too large for its volume:** `max_size` or `min_free` sized to the whole disk, or a cache sharing `/` (lab)                                      | Holds the disk flat near full. This matches "consistently at 99%". In the lab, `max_size=63m` on a 64 MiB volume sat at 98%, and 4 of 5 new 1 MiB downloads were truncated | Lower `max_size` or raise `min_free`, then `nginx -s reload`. The cache manager evicts (lab: 98% to 69%)                                                                                                                               | `max_size` at about 70% of a dedicated cache volume, plus `min_free`                                                                                                                            |
| **Proxy cache without `max_size`** (lab)                                                                                                                      | Grows until the volume is full                                                                                                                                             | Add `max_size` and `min_free`, then reload (lab: 99% to 50%). Deleting cache files is also safe: a missing file is a miss                                                                                                              | As above. `max_size` is enforced after the fact: right after the fix, a burst of 100 new 1 MiB objects refilled the volume to 99% and 72 were truncated, before eviction brought it back to 49% |
| **Logs not rotated:** a path no rule matches (lab), `logrotate.service` failing while its timer runs, or daily rotation that traffic outgrows                 | Grows until `/` is full                                                                                                                                                    | `mv` the file aside, `nginx -s reopen`, copy it to another filesystem, then delete it. `truncate -s 0` only if the log can be lost (lab: 100% to 1%)                                                                                   | A rule per log path with `maxsize`, an hourly timer and a reopen. Alert on `logrotate.service` failures. Ship logs off the box                                                                  |
| **Log flood:** an attack or a retry storm inflating the access log, or an upstream outage flooding the error log                                              | Grows fast. Fix the flood itself, not just the disk                                                                                                                        | `limit_req` or the WAF for the flood. `error_log ... warn;` and reload for the error log                                                                                                                                               | `access_log <path> combined buffer=64k gzip` or conditional logging (`if=`) for noisy paths. `warn` level                                                                                       |
| **Retention sized to the disk:** `rotate 14` of a daily volume near the disk size                                                                             | A flat line with a daily sawtooth                                                                                                                                          | Delete the oldest rotated copies; they are closed files                                                                                                                                                                                | Retention by size, logs shipped off the box                                                                                                                                                     |
| **Deleted but still open:** someone ran `rm` on a live log (lab), or a log shipper (Filebeat, Fluent Bit, Vector, CloudWatch agent) still holds rotated files | The `rm` frees nothing, and `du` cannot see the space                                                                                                                      | NGINX: `nginx -s reopen` (lab: 100% to 1%). A shipper: restart it, and set it to close removed files. Truncating via `/proc/PID/fd/N` only if the content can be lost; otherwise restart that process                                  | Never `rm` a live log. Rotate only through logrotate with a reopen                                                                                                                              |
| **Inodes exhausted:** many small cache or temp files (lab)                                                                                                    | Bytes 10% used, yet the volume refuses new files                                                                                                                           | Delete cache files, or files in the directory with the most entries after confirming they are disposable                                                                                                                               | Size `keys_zone` below the volume's inode count (1 MB holds about 8,000 keys). Alert on inodes                                                                                                  |
| **Disk not in the filesystem:** guided LVM left half the disk free, or the disk was resized but not the partition and filesystem (lab, opt-in)                | The filesystem is 31 GB, not 64 GB                                                                                                                                         | Grow by what is needed, online: `sudo lvextend -r -L +10G /dev/ubuntu-vg/ubuntu-lv` (lab: 100% to 34%). ext4 cannot shrink online, and free extents leave room for snapshots. If the disk was resized, first `growpart` and `pvresize` | Check at build time that the root filesystem fills the disk                                                                                                                                     |
| **NGINX in Docker:** json-file logs with no `max-size`                                                                                                        | Grows under `/var/lib/docker`                                                                                                                                              | Set `max-size` and recreate the container                                                                                                                                                                                              | `log-opts` in `daemon.json`                                                                                                                                                                     |
| **journald and rsyslog:** persistent journal (10% of the filesystem, at most 4 GiB) plus `/var/log/syslog`                                                    | Often several GB                                                                                                                                                           | `journalctl --rotate --vacuum-size=500M`                                                                                                                                                                                               | `SystemMaxUse=1G`. Ship logs instead of keeping two local copies                                                                                                                                |
| **Other writers:** crash dumps, old kernels filling `/boot`, snap revisions, apt cache, a forgotten `tcpdump`                                                 | `/boot` full blocks security updates                                                                                                                                       | Copy crash dumps off the box, then `apt autoremove --purge`, `apt-get clean`, `snap set system refresh.retain=2`                                                                                                                       | The growth-rate alert below                                                                                                                                                                     |

The script checks every row. The lab tests six of them end to end, plus the parsing of
statements split across lines, quoted includes, logrotate's globs and ignored files. Not
reproduced: the log flood, retention, a failing logrotate, log shippers, Docker, journald,
the other writers, and files hidden under a mount point.

## 5. If it is at 100% right now

1. **Measure what clients see.**
   - Send a large POST and a large GET through the load balancer, and compare each body
     with its `Content-Length`.
   - Check the 5xx rate.
   - Check the error log for `(28: No space left on device)`, but only if it lives on
     another filesystem: in the lab, a full `/` left it empty.
2. **Stop the growth.**
   - Find the writer: `sudo find / -xdev -mmin -10 -size +100M`.
   - If the error log is flooding, set `error_log ... warn;` and `nginx -s reload`.
3. **Free space without a restart:**

   | What holds the space                | Action                                                                                          |
   | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
   | Deleted files NGINX still holds     | `nginx -s reopen`                                                                               |
   | Deleted files another process holds | Restart or reload that process. Truncating via `/proc/PID/fd/N` only if the content can be lost |
   | A live log you can lose             | `truncate -s 0`, never `rm`                                                                     |
   | A live log you must keep            | `mv` it aside, `nginx -s reopen`, copy it off the box, then delete it                           |
   | Old rotated logs, journal, packages | Delete the oldest `.gz` files; `journalctl --rotate --vacuum-size=500M`; `apt-get clean`        |
   | Cache entries                       | Lower `max_size` and reload, or delete them; NGINX treats them as misses                        |

4. **Emergency headroom.** ext4 keeps 5% of the filesystem for root, up to 3.2 GB here.
   `tune2fs -m 1 /dev/<root>` releases most of it, and `tune2fs -m 5` puts it back once
   the fix is in.
5. **The fix.** Grow the volume online, or add the missing rotation or cache limit.

Avoid three things on a live load balancer:

- `rm` on an open file;
- restarting NGINX when `reopen` or `reload` will do;
- emptying `/var/lib/nginx` while requests are using its temp files.

## 6. Prevention

| Control                          | Setting                                                                                                                                                                                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rotate by size as well as time   | `maxsize 1G`, `rotate 7`, `compress`, `postrotate` with a reopen (Ubuntu's rule has one); `logrotate.timer` hourly                                                                                                                                                          |
| Logs off the box                 | CloudWatch agent or Vector to central storage, set to release rotated files; keep a day or two locally                                                                                                                                                                      |
| Bounded cache, on its own volume | `max_size` at about 70% of the volume, plus `min_free`, `keys_zone` sized for the inode count, `use_temp_path=off`                                                                                                                                                          |
| Separate volumes                 | `/var/log`, `/var/cache/nginx` and `/var/lib/nginx` off root, so a full one cannot take SSH, apt and certificate renewal down with it                                                                                                                                       |
| Bounded journal                  | `SystemMaxUse=1G` in `/etc/systemd/journald.conf.d/`                                                                                                                                                                                                                        |
| Alert on time to full            | `predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs\|overlay\|squashfs"}[6h], 4*3600) < 0` pages; a 3-day horizon opens a ticket                                                                                                                                     |
| Alert on a flat line near full   | `node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.05` for 1 h; `predict_linear` never fires on a flat line                                                                                                                                                      |
| Alert on inodes                  | `node_filesystem_files_free / node_filesystem_files < 0.10`                                                                                                                                                                                                                 |
| Alert on what clients get        | A synthetic probe through the load balancer: a large POST, and a large GET at a limited rate, checking status and body size against `Content-Length`. Plus the rate of `No space left on device` in an error log shipped through syslog, so the full disk cannot silence it |
| Check at build time              | The root filesystem fills the disk (`lsblk` against `df`), and every `access_log` path has a logrotate rule                                                                                                                                                                 |

## 7. The bigger risk

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
# On the VM. Read-only. WARN_PCT, MIN_MB and SAMPLE_S tune what counts as a finding.
sudo bash triage.sh

# The lab: Docker only, removes its containers and image afterwards.
src/problem2/lab/run.sh
# The LVM case needs a privileged container for the loop device.
src/problem2/lab/run.sh lvm-free
```
