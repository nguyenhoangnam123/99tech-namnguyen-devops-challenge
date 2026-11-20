# Lab results

Each scenario runs Ubuntu 24.04 with its own NGINX package in a container. A small
filesystem stands in for the VM's disk, so `df` really reads full:

- a 64 MiB tmpfs at `/var`, holding the logs and NGINX's `/var/lib/nginx` buffers together,
  as the root filesystem does on the VM;
- or a 64 MiB tmpfs at `/var/cache/nginx`, for a dedicated cache volume;
- or a 100 MiB logical volume (`lvm-free`).

Socket buffers are cut to 16 KiB, as for a distant client, so NGINX must spool large
responses to disk. For each scenario, `run.sh`:

1. breaks it, filling the filesystem to the last byte;
2. sends new requests through the proxy: 100 small GETs, 20 POSTs of 64 KiB, and 5
   downloads of 1 MiB at 512 KiB/s. A body shorter than its `Content-Length` counts as
   truncated;
3. runs [triage.sh](../scripts/triage.sh) and checks that it names the cause;
4. recovers without restarting NGINX, while small GETs keep arriving at about 15 a second;
5. checks that the cause is gone and that every probe succeeds.

`parsing` instead checks the report against configs that are easy to misparse:

- statements split across lines, or sharing one;
- a quoted include;
- a logrotate `*` that must not match a slash;
- a rule file logrotate ignores;
- a reopen done by `systemctl reload`.

Run on 2026-11-20 on Docker 28.1.1 (Linux 6.10, arm64): `lab/run.sh`, then
`lab/run.sh lvm-free`. The access logs were grown with synthetic log lines rather than
weeks of traffic.

```text
== deleted-open
broken:    /var   64M   64M     0 100%    1%  (size used avail use% inodes%)
requests:  GET 3 B: 100 x 200
requests:  POST 64 KiB: 20 x 500
requests:  GET 1 MiB to a slow client: 5 x 200 truncated
requests:  access log: +0 bytes for those 125 requests
triage:    - deleted-open: NGINX (12) holds 64 MiB in deleted log files; 'nginx -s reopen' frees it
during:    70 x 200  (live GETs, 1 s before recovery to 2 s after)
recovered: /var   64M  4.0K   64M   1%    1%
requests:  GET 3 B: 100 x 200
requests:  POST 64 KiB: 20 x 200
requests:  GET 1 MiB to a slow client: 5 x 200
requests:  access log: +12933 bytes for those 125 requests
PASS
== log-not-rotated
broken:    /var   64M   64M     0 100%    1%  (size used avail use% inodes%)
requests:  GET 3 B: 100 x 200
requests:  POST 64 KiB: 20 x 500
requests:  GET 1 MiB to a slow client: 5 x 200 truncated
requests:  access log: +0 bytes for those 125 requests
triage:    - log-not-rotated: /var/log/lb/access.log is 64 MiB and no logrotate rule matches it
recovery:  considering log /var/log/lb/access.log
during:    79 x 200  (live GETs, 1 s before recovery to 2 s after)
recovered: /var   64M  4.0K   64M   1%    1%
requests:  GET 3 B: 100 x 200
requests:  POST 64 KiB: 20 x 200
requests:  GET 1 MiB to a slow client: 5 x 200
requests:  access log: +12933 bytes for those 125 requests
PASS
== inodes
broken:    /var/cache/nginx   64M  6.4M   58M  10%  100%  (size used avail use% inodes%)
requests:  GET 3 B: 100 x no reply
requests:  POST 64 KiB: 20 x 200
requests:  GET 1 MiB to a slow client: 5 x no reply
requests:  access log: +12528 bytes for those 125 requests
triage:    - inodes: /var/cache/nginx has used 100% of its inodes (3000 files and directories); bytes are not the limit
during:    18 x no reply, 35 x 200  (live GETs, 1 s before recovery to 2 s after)
recovered: /var/cache/nginx   64M  140K   64M   1%    3%
requests:  GET 3 B: 100 x 200
requests:  POST 64 KiB: 20 x 200
requests:  GET 1 MiB to a slow client: 5 x 200
requests:  access log: +12933 bytes for those 125 requests
PASS
== cache-unbounded
broken:    /var/cache/nginx   64M   64M  768K  99%    1%  (size used avail use% inodes%)
requests:  GET 3 B: 100 x 200
requests:  POST 64 KiB: 20 x 200
requests:  GET 1 MiB to a slow client: 5 x 200 truncated
requests:  access log: +12551 bytes for those 125 requests
triage:    - cache-unbounded: cache /var/cache/nginx/api has no max_size, holds 63 MiB and grows until the disk is full
during:    69 x 200  (live GETs, 1 s before recovery to 2 s after)
recovered: /var/cache/nginx   64M   32M   33M  50%    1%
requests:  GET 3 B: 100 x 200
requests:  POST 64 KiB: 20 x 200
requests:  GET 1 MiB to a slow client: 5 x 200
requests:  access log: +12933 bytes for those 125 requests
burst:     100 new 1 MiB objects: 28 x 200, 72 x 200 truncated
burst:     just after: 99%
10 s later: /var/cache/nginx   64M   32M   33M  49%    1%
PASS
== cache-limit
broken:    /var/cache/nginx   64M   63M  1.8M  98%    1%  (size used avail use% inodes%)
requests:  GET 3 B: 100 x 200
requests:  POST 64 KiB: 20 x 200
requests:  GET 1 MiB to a slow client: 1 x 200, 4 x 200 truncated
requests:  access log: +12553 bytes for those 125 requests
triage:    - cache-limit: cache /var/cache/nginx/api, once full, holds its filesystem at about 98% (max_size 63m, min_free unset, filesystem 64 MiB)
during:    69 x 200  (live GETs, 1 s before recovery to 2 s after)
recovered: /var/cache/nginx   64M   44M   21M  69%    1%
requests:  GET 3 B: 100 x 200
requests:  POST 64 KiB: 20 x 200
requests:  GET 1 MiB to a slow client: 5 x 200
requests:  access log: +12933 bytes for those 125 requests
PASS
== parsing
  found:  ^- log-not-rotated: /var/log/sub/quoted.log
  found:  ^/var/log/mid/access.log: .*rule: daily
  found:  ^cache /var/cache/nginx/api: .*max_size=32m
  absent: cache-unbounded
  absent: rotate-no-reopen
  absent: log-not-rotated: /var/log/mid/
PASS
== lvm-free
broken:    /var/log   90M   88M     0 100%    1%  (size used avail use% inodes%)
requests:  GET 3 B: 100 x 200
requests:  POST 64 KiB: 20 x 200
requests:  GET 1 MiB to a slow client: 5 x 200
requests:  access log: +0 bytes for those 125 requests
triage:    - lvm-free: volume group lab has 296 MiB unallocated; grow by what is needed, e.g. 'lvextend -r -L +10G /dev/mapper/lab-logs', as ext4 cannot shrink online
recovery:  Filesystem at /dev/mapper/lab-logs is mounted on /var/log; on-line resizing required
recovery:  The filesystem on /dev/mapper/lab-logs is now 76800 (4k) blocks long.
during:    53 x 200  (live GETs, 1 s before recovery to 2 s after)
recovered: /var/log  278M   88M  178M  34%    1%
requests:  GET 3 B: 100 x 200
requests:  POST 64 KiB: 20 x 200
requests:  GET 1 MiB to a slow client: 5 x 200
requests:  access log: +12933 bytes for those 125 requests
PASS
```

## What the runs show

| Scenario               | Reproduced as                                                                                                | While full                                                                                                                                                               | Recovery, with live GETs running                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| deleted-open           | The access log is `rm`-ed while NGINX still writes to it. `df` reads 64 MiB used, `du` 0 MiB                 | Small GETs succeed. **POSTs over the body buffer get 500, and slow downloads are cut short**, because `/var/lib/nginx` is on the same filesystem. New log lines are lost | `nginx -s reopen`: 100% to 1%; 70 of 70 live GETs OK                                                |
| log-not-rotated        | `access_log /var/log/lb/access.log` added by hand; no logrotate rule matches that path                       | As above                                                                                                                                                                 | Move the file, reopen, archive it elsewhere, add the rule: 100% to 1%; 79 of 79 OK                  |
| inodes                 | A 3,000-inode cache volume filled by small cached responses; bytes only 10% used                             | **Every new GET gets no reply**: NGINX cannot create the cache file and drops the connection. POSTs are not cached and succeed                                           | Delete the cache files: 18 live GETs sent before the delete got no reply, the 35 after it succeeded |
| cache-unbounded        | `proxy_cache_path` without `max_size`                                                                        | **Slow 1 MiB downloads are 200s with truncated bodies.** Status-code monitoring sees success                                                                             | Add `max_size=32m` and reload: 99% to 50%; 69 of 69 OK                                              |
| cache-unbounded, burst | 100 new 1 MiB objects at once, right after the fix                                                           | 72 of 100 truncated: `max_size` is enforced after the fact                                                                                                               | Back to 49% within 10 s, with no action                                                             |
| cache-limit            | `max_size=63m` on a 64 MiB volume                                                                            | Sits flat at 98% once full, the "consistently at 99%" shape. 4 of 5 new downloads truncated                                                                              | Lower `max_size` to 44m and reload: 98% to 69%; 69 of 69 OK                                         |
| lvm-free               | A 100 MiB logical volume in a 400 MiB volume group, as Ubuntu's installer leaves root at about half the disk | Logs only on this volume, so only new log lines are lost                                                                                                                 | `lvextend -r -L +200M`, online: 100% to 34%; 53 of 53 OK                                            |

Manual checks, outside `run.sh`:

- **The error log stays silent on a full `/`.** In the deleted-open case,
  `/var/log/nginx/error.log` grew 0 bytes while the probes failed. An alert on
  `No space left on device` only works if the error log lives elsewhere.
- **Messages when the error log can be written** (inode and cache cases):
  - inodes: `mkdir() "/var/cache/nginx/api/3/87" failed (28: No space left on device) while reading upstream`;
  - a byte-full cache: `pwritev() "...0000000199" has written only 16384 of 36864 while reading upstream`.
- **URLs cached before the inodes ran out kept working:** 100 of 100 returned 200.
- **tmpfs has no ext4 root reserve,** so `df` reaches 100% exactly as root writes. The
  `lvm-free` volume is ext4: there, the fill ran as root and used the 5 MiB reserve too.

`lvm-free` needs `--privileged` for a loop device and device mapper, so it is opt-in and
stays out of CI. Its teardown removes both from the Docker host kernel.

## A full report

The deleted-open case, as `triage.sh` prints it. Container-only mounts are left out.

```text
Disk triage on 7a862f48ed91 at 2026-11-20T05:29:19Z; kernel 6.10.14-linuxkit

== Filesystems (bytes and inodes, local only)
Filesystem     Type     Size  Used Avail Use% Mounted on
overlay        overlay 1007G   55G  901G   6% /
tmpfs          tmpfs     64M   64M     0 100% /var
FULL bytes: /var at 100% (64 of 64 MiB)

== Space df counts but du cannot see
/var: df used 64 MiB, du sees 0 MiB, gap 64 MiB
  The gap is deleted files still held open, or files hidden under a mount point.

== Deleted files still held open
        64 MiB  /var/log/nginx/access.log  held by nginx 12 fd 4

== Largest directories
on /var:
       0.0 MiB  /var/tmp
       0.0 MiB  /var/log/nginx
       0.0 MiB  /var/log/lb
       0.0 MiB  /var/log
       0.0 MiB  /var/lib/nginx
       0.0 MiB  /var/lib/logrotate
       0.0 MiB  /var/lib
       0.0 MiB  /var/cache/nginx
       0.0 MiB  /var/cache
       0.0 MiB  /var

== Usual suspects
         0 MiB  /var/log
         0 MiB  /var/log/nginx
         0 MiB  /var/cache/nginx
         0 MiB  /var/lib/nginx
         0 MiB  /tmp
         0 MiB  /var/tmp
         0 MiB  /boot

== NGINX logs and rotation
/var/log/nginx/error.log: 0 MiB, rotated copies 0 MiB; rule: daily missingok rotate 14 compress delaycompress notifempty create 0640 www-data adm

== Proxy cache and temp files
temp /var/lib/nginx/body: 0 MiB on /var
temp /var/lib/nginx/fastcgi: 0 MiB on /var
temp /var/lib/nginx/proxy: 0 MiB on /var
temp /var/lib/nginx/scgi: 0 MiB on /var
temp /var/lib/nginx/uwsgi: 0 MiB on /var

== journald and syslog
Archived and active journals take up 0B in the file system.
journal on disk: 0 MiB (/run/log/journal is in memory); SystemMaxUse not set (default: 10% of the filesystem, at most 4 GiB)

== Block devices and filesystem size
NAME     SIZE TYPE FSTYPE MOUNTPOINTS
vda        1T disk
`-vda1  1024G part        /etc/hosts
                          /etc/hostname
                          /etc/resolv.conf
vdb    537.4M disk
/: source overlay is not a block device, skipped
/var: source tmpfs is not a block device, skipped

== Growth during this run
/var: no growth in 5 s

== Likely causes
- deleted-open: NGINX (12) holds 64 MiB in deleted log files; 'nginx -s reopen' frees it
- temp-on-full-fs: NGINX buffers to /var/lib/nginx/body on the full /var, so large request bodies and large responses to slow clients fail
```
