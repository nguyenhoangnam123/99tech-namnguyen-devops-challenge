# Problem 2: Diagnose Me Doctor

[README](../README.md) · Answer: [SOLUTION.md](../src/problem2/SOLUTION.md) · Previous: [Problem 1](problem1.md) · Next: [Problem 3](problem3.md)

An Ubuntu 24.04 VM running only NGINX as a load balancer, with its 64 GB disk at 99%.

## What the brief asks, and where it is answered

| The brief asks for           | Answer                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How you would troubleshoot   | Look before deleting ([§1](../src/problem2/SOLUTION.md#1-the-first-five-minutes-look-dont-delete)), then symptom to cause ([§2](../src/problem2/SOLUTION.md#2-from-symptom-to-cause)). Scripted, read-only: [triage.sh](../src/problem2/scripts/triage.sh)    |
| The causes you expect        | Eleven, from an unbounded cache to deleted files still held open ([§4](../src/problem2/SOLUTION.md#4-causes-impact-recovery-prevention))                                                                                                                      |
| Impact and recovery for each | The same table, with recovery that never restarts NGINX. What clients see on a full disk, measured ([§3](../src/problem2/SOLUTION.md#3-what-a-full-disk-does-to-traffic)); what to do at 100% ([§5](../src/problem2/SOLUTION.md#5-if-it-is-at-100-right-now)) |
| Proof                        | A [lab](../src/problem2/lab/RESULTS.md) reproduces six causes and checks that the script names each one and that recovery serves live traffic                                                                                                                 |

The brief asks for "two production issues" but describes one scenario. It is treated as one
scenario with several possible root causes.

## Documents

| Document                                               | What it covers                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| [SOLUTION.md](../src/problem2/SOLUTION.md)             | Triage, the causes with impact, recovery and prevention, and what to do at 100% |
| [scripts/triage.sh](../src/problem2/scripts/triage.sh) | The read-only triage script to run on the VM                                    |
| [lab/RESULTS.md](../src/problem2/lab/RESULTS.md)       | What the lab reproduced, what the script reported, and a full report            |
| [lab/run.sh](../src/problem2/lab/run.sh)               | Runs each scenario in its own Ubuntu 24.04 container with a small, filling disk |
| [lab/conf/](../src/problem2/lab/conf)                  | The NGINX and logrotate configs for each scenario                               |

## Check it yourself

Requires Docker and Bash 4 or later (on macOS, `brew install bash`). The lab removes its containers and image afterwards.

```bash
src/problem2/lab/run.sh             # five causes and the config parsing check
src/problem2/lab/run.sh lvm-free    # the LVM case, which needs a privileged container
sudo bash src/problem2/scripts/triage.sh   # on a real VM; read-only
```

CI runs shellcheck and every scenario but the LVM one: [p2-disk](../.github/workflows/p2-disk.yml).
