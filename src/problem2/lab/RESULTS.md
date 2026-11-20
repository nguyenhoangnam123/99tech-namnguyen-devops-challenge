# Lab results

Each scenario runs Ubuntu 24.04 with its own NGINX package in a container. A small
filesystem (64 MiB tmpfs, or a 100 MiB logical volume) stands in for the VM's disk, so
`df` really reads full. For each scenario, `run.sh`:

1. breaks it;
2. sends requests through the proxy;
3. runs [triage.sh](../scripts/triage.sh) and checks that it names the cause;
4. recovers without restarting NGINX;
5. checks that the cause is gone and that requests succeed.

Run on 2026-11-20 on Docker 28.1.1 (Linux 6.10, arm64) with
`lab/run.sh deleted-open log-not-rotated inodes cache-unbounded lvm-free`. The access logs
were grown with synthetic log lines rather than weeks of traffic.

```text
== deleted-open
broken:    /var/log   64M   64M  292K 100%    1%  (size used avail use% inodes%)
requests:  100 x 200
triage:    - deleted-open: 64 MiB in deleted files still open, mostly /var/log/nginx/access.log (nginx 12). Free it with 'nginx -s reopen' for NGINX logs, or ': > /proc/12/fd/4'
recovered: /var/log   64M     0   64M   0%    1%
requests:  100 x 200
PASS
== log-not-rotated
broken:    /var/log   64M   64M  300K 100%    1%  (size used avail use% inodes%)
requests:  100 x 200
triage:    - log-not-rotated: /var/log/lb/access.log is 64 MiB and no logrotate rule matches it
recovery:  considering log /var/log/lb/access.log
recovered: /var/log   64M     0   64M   0%    1%
requests:  100 x 200
PASS
== inodes
broken:    /var/cache/nginx   64M  6.4M   58M  10%  100%  (size used avail use% inodes%)
requests:  100 x no reply
triage:    - inodes: /var/cache/nginx has used 100% of its inodes (3000 files and directories); bytes are not the limit
recovered: /var/cache/nginx   64M     0   64M   0%    1%
requests:  100 x 200
PASS
== cache-unbounded
broken:    /var/cache/nginx   64M   64M  768K  99%    1%  (size used avail use% inodes%)
requests:  20 x 200 truncated
triage:    - cache-unbounded: cache /var/cache/nginx/api has no max_size, holds 63 MiB and grows until the disk is full
recovered: /var/cache/nginx   64M   32M   33M  49%    1%
requests:  20 x 200
burst:     12 x 200, 88 x 200 truncated
burst:     just after: 99%
10 s later: /var/cache/nginx   64M   32M   33M  49%    1%
PASS
== lvm-free
broken:    /var/log   90M   83M  300K 100%    1%  (size used avail use% inodes%)
requests:  100 x 200
triage:    - lvm-free: volume group lab has 296 MiB unallocated; lvextend -r -l +100%FREE /dev/mapper/lab-logs
recovery:  Filesystem at /dev/mapper/lab-logs is mounted on /var/log; on-line resizing required
recovery:  The filesystem on /dev/mapper/lab-logs is now 101376 (4k) blocks long.
recovered: /var/log  367M   83M  270M  24%    1%
requests:  100 x 200
PASS
```

## What the runs show

| Scenario               | Reproduced as                                                                                              | While full                                                                                           | Recovery                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| deleted-open           | The 64 MiB access log is `rm`-ed while NGINX still writes to it. `df` reads 63 MiB used, `du` 0 MiB        | Requests succeed. Deleting the file freed nothing                                                    | `nginx -s reopen`: 100% to 0% at once                                                                            |
| log-not-rotated        | `access_log /var/log/lb/access.log` added by hand; no logrotate rule matches that path                     | Requests succeed                                                                                     | Move the file, `nginx -s reopen`, archive it to another filesystem, add the rule; `logrotate -d` now picks it up |
| inodes                 | 3,000-inode cache filesystem filled by small cached responses; bytes only 10% used                         | **Every new request fails with no reply.** NGINX cannot create cache files and closes the connection | Delete the cache files; NGINX treats a missing cache file as a miss                                              |
| cache-unbounded        | `proxy_cache_path` without `max_size`; 1 MiB responses                                                     | **Every new response is a 200 with a truncated body**, so clients see success but get broken data    | Add `max_size=32m` and reload: the cache manager evicts down to 49%                                              |
| cache-unbounded, burst | 100 new 1 MiB objects at once, right after the fix                                                         | 88 of 100 truncated: `max_size` is enforced after the fact                                           | Back to 49% within 10 s, with no action                                                                          |
| lvm-free               | 100 MiB logical volume in a 400 MiB volume group, as Ubuntu's installer leaves root at about half the disk | Requests succeed                                                                                     | `lvextend -r -l +100%FREE`, online: 100% to 24%                                                                  |

Two more checks from a manual run of the inode case, with the same setup:

- **URLs cached before the filesystem filled kept working:** 100 of 100 returned 200.
- **New URLs failed:** 100 of 100 got no reply.
- **Error log:** 3,468 `No space left on device` lines, for example
  `mkdir() "/var/cache/nginx/api/3/87" failed (28: No space left on device) while reading upstream`.

On a byte-full cache, the error log shows
`pwritev() "...0000000199" has written only 16384 of 36864 while reading upstream`.

`lvm-free` needs `--privileged` for a loop device and device mapper, so it is opt-in
(`lab/run.sh lvm-free`). Its teardown removes both from the Docker host kernel. After the
run, a privileged container listed no loop or device-mapper devices.

## A full report

The deleted-open case, as `triage.sh` prints it:

```text
== Filesystems (bytes and inodes)
Filesystem     Type     Size  Used Avail Use% Mounted on
overlay        overlay 1007G   55G  902G   6% /
tmpfs          tmpfs     64M   64M  292K 100% /var/log
FULL bytes: /var/log at 100% (63 of 64 MiB)

== Space df counts but du cannot see
/var/log: df used 63 MiB, du sees 0 MiB, gap 63 MiB
  The gap is deleted files still held open, or files hidden under a mount point.

== Deleted files still held open
        64 MiB  /var/log/nginx/access.log  held by nginx 12 fd 4

== NGINX logs and rotation
/var/log/nginx/error.log: 0 MiB, rotated copies 0 MiB; rule: daily missingok rotate 14 compress delaycompress notifempty create 0640 www-data adm

== Likely causes
- deleted-open: 64 MiB in deleted files still open, mostly /var/log/nginx/access.log (nginx 12). Free it with 'nginx -s reopen' for NGINX logs, or ': > /proc/12/fd/4'
```

Some sections and container-only mounts are left out of this excerpt. Every report also
covers:

- the largest directories;
- known space users: journal, crash dumps, apt cache, kernels and snaps;
- proxy cache and temp paths;
- block devices versus filesystem size.
