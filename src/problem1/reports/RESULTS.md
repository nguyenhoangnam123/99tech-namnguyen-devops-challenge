# Wave 1 results

**Environment:** one MacBook (M2 Pro, 10 cores). Docker Desktop VM with 10 vCPU and 8 GB,
running all 12 containers plus k6. Each Node service is limited to 1 CPU, Postgres to 2,
Kafka to 1.5. SLO runs add the six observability containers and trace 10% of requests.

## Test suites

All suites were run on a fresh default stack, telemetry off as in CI. Raw output is in
[tests/](tests).

| Suite | Result | Notes |
|---|---|---|
| Unit and property | 94 passed | fast-check runs 100 random command streams per property |
| Integration (real Postgres) | 7 passed | testcontainers; includes the settlement deadlock race |
| E2E transactions and contract | 30 passed | ledger invariants checked after every file |
| Chaos | 2 passed | matcher restart rebuilt by replay; settler SIGKILL settled exactly once |
| Abuse (pen test) | 16 passed | [tests/security.txt](tests/security.txt) |
| OWASP ZAP API scan | 0 High, 0 Medium, 0 Low | previous round, API unchanged; [zap/](zap) |
| Dependency audit | 0 production vulnerabilities | previous round; 2 moderate, dev-only |

## SLO catalog

Seven scenarios, each with its own load, window, size and p95/p99 objective, run by
`make slo` on commit `d020274`. Full output, with CPU and memory for every container, is
in [slo/RESULTS.md](slo/RESULTS.md); every number is also in `slo/RESULTS.json`.

| Scenario | Load | p95 / p99 measured | Objective | Verdict |
|---|---|---:|---:|---|
| market-browse | 300 req/s public reads | 2.8 / 12.5 ms | 10 / 30 ms | met |
| deep-book | 200 req/s, 100-level depth of a 1,000-level book | 4.4 / 27.1 ms | 15 / 40 ms | met |
| account-reads | 150 req/s balances, orders, fills | 7.7 / 22.0 ms | 15 / 40 ms | met |
| order-entry | 200 req/s place and cancel | 13.3 / 42.6 ms | 25 / 75 ms | met |
| **peak-mix (P1 target)** | **500 req/s mixed** | **12.6 / 51.3 ms** | **25 / 100 ms** | **met** |
| traders-50 | 50 closed-loop traders, 426 orders/s | 50.0 / 104.0 ms | 30 / 100 ms | missed |
| traders-200 | 200 closed-loop traders, 638 orders/s | 218.1 / 326.5 ms | 60 / 150 ms | missed |

Every open-model scenario met its objective with no dropped requests, including the P1
target. The two closed-loop scenarios send nothing but orders, at 3 to 5 times peak-mix's
order rate, and they find the limits:

- **API CPU.** oms-api used 124% of its two cores in traders-50 and 171% in traders-200.
  Each replica is one event loop, so latency queues there. More replicas
  (`OMS_API_REPLICAS`) is the lever; tracing alone adds about 10 ms of p95 at this load
  ([slo/OVERHEAD.md](slo/OVERHEAD.md)).
- **Settlement per market.** One market settles serially, about 450 commands/s on this
  laptop. Settled p99 was 154 ms in peak-mix, 2.3 s in traders-50 and over 10 s in
  traders-200. Batching several commands per transaction, or more markets, raises it.

The objectives were set before measuring and are kept. Moving them until everything
passes would hide what these two scenarios exist to show.

How runs are kept comparable (empty state, drained setup, warm-up, VM stall capture) is in
[docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md#7-slo-tests).

## Load: 500 rps for 2 minutes, open model

The scenario is [tests/perf/load.js](../tests/perf/load.js), with 40 funded users and a
seeded book:

- **Reads:** 125/s depth, 50/s ticker, 50/s trades, 50/s balances, 50/s open orders.
- **Writes:** 125/s orders (20% crossing IOC orders that trade) and 25/s cancels.

| Metric | Result | Target |
|---|---:|---:|
| p50, all requests | 1.7 ms | |
| p95, all requests | 6.2 ms | |
| **p99, all requests** | **18.5 ms** | < 100 ms ✓ |
| p99, place order | 36.8 ms | < 100 ms ✓ |
| p99, balances | 12.5 ms | < 100 ms ✓ |
| p99, depth | 9.6 ms | < 100 ms ✓ |
| Failed requests | 3 of 60,296 (0.005%) | < 0.1% ✓ |
| Dropped iterations | 0 | |
| Max | 1.01 s (one request) | |

### What drives the tail

One earlier run failed the target, with a 1.5 s p99. It ran while other heavy jobs shared
the Docker VM. Postgres slow-statement logging on a later run showed that, on this laptop,
the order path's tail is mostly `COMMIT`:

- Commits averaged 43 ms and reached 110 ms: WAL fsync through Docker Desktop's virtual disk.
- Lock waits behind settlement were 12–30 ms.

The placement transaction already commits exactly once, and turning off synchronous commit
is not acceptable for a ledger. On Aurora, quorum commits take a few milliseconds, so the
wave 2 latency budget assumes that rather than this laptop's disk.

Run-to-run variance on endpoints a change does not touch is about ±12% here. Treat
single-digit differences as noise.

## A/B: indexing the ledger account lookup

`make ab A=ec7869b B=b506779`: same scenario, fresh stack per side.

| Metric | A (sequential scan) | B (expression index) | Change |
|---|---:|---:|---:|
| p99 all requests (ms) | 25.0 | 22.4 | -10.4% |
| p99 place order (ms) | 54.2 | 45.8 | -15.6% |
| p99 balances (ms), untouched | 16.3 | 18.3 | +11.9% |
| p99 depth (ms), untouched | 13.3 | 14.2 | +6.2% |

The order path improved by about 16%, near the noise band. The real reason for the change is
scalability: `IS NOT DISTINCT FROM` made every ledger post scan the whole accounts table.
EXPLAIN shows 0.51 ms falling to 0.14 ms at about 1,100 accounts, and the scan grows
linearly with users while the index lookup does not.

## Independent QA review

A read-only reviewer was briefed with the intended behaviour, not with conclusions.

| Round | Blockers | Major | Outcome |
|---|---:|---:|---|
| 1 | 2 | 2 | All fixed with regression tests (fixes listed below) |
| 2 | 0 | 0 | Minor items fixed; two documented as deferred in ADRs 0003 and 0004 |

Round 1 findings:

- **Blocker:** the matcher committed offsets with no events after a failed batch.
- **Blocker:** an uncapped sweep could exceed Kafka's message size and halt matching.
- **Major:** the login lockout was check-then-act.
- **Major:** settlement trusted the trade's terms.

## Findings caught by the suites

- **Spoofable client IP.** The edge appended `X-Forwarded-For`, so per-IP limits could be
  bypassed. 330 spoofed logins got no 429
  ([before-xff-fix.txt](security/before-xff-fix.txt)); fixed by overwriting the header.
- **Login floods could starve trading.** Concurrent scrypt hashes starved the event loop:
  220 of 330 requests failed and Postgres pool acquisition timed out. Fixed with bounded
  hashing that sheds load with a 503.
- **Slow settler failover.** A killed settler's replacement waited 25 s for its partitions.
  Fixed with static Kafka group membership; failover is now immediate.
- **Spec not compiled until first request.** An invalid `nullable` combination only failed
  on the first request after deploy. A platform test now compiles every spec.
