# Tracing overhead and the default sampling ratio

**Question:** what does OpenTelemetry tracing cost this stack, and which head-sampling
ratio should SLO runs use?

**Answer:** SLO runs sample 10% (`make slo` default `SAMPLE=0.1`). `make up-obs` keeps
every trace, because local debugging wants them all and its traffic is low. Most of the
cost is fixed instrumentation work, not the ratio, so tracing off would report latency
the system never shows once it is instrumented.

## Method

- Six arms interleaved A B C C B A, so steady drift and background load cancel out:
  off, 100%, 10%, 10%, 100%, off. Same commit and image in every arm.
- Each arm is `make slo SCENARIOS=peak-mix,traders-50 WINDOW=60s` with `TELEMETRY` and
  `SAMPLE` set. Every arm starts from empty exchange state, waits for setup's orders to
  settle, warms up for 15 s and then measures 60 s.
- `peak-mix` is open-model: 500 req/s offered whatever the latency. `traders-50` is
  closed-loop: 50 traders each place an order, think 100 ms, repeat. Overhead shows as
  CPU in the first and as latency and throughput in the second.
- Docker VM stall time (PSI from node-exporter) is recorded for every window to rule out
  the host. It stayed low and similar across arms: memory at most 0.2%, IO at most 2.7%.
- Raw output per arm: `overhead/<arm>.md` and `overhead/<arm>.json`.

## Results

Means of the two arms per setting. CPU is % of one core, summed over replicas; oms-api is
two replicas with one core each.

| Scenario   | Tracing | p95 ms | p99 ms | Req/s | oms-api CPU | Postgres CPU | Spans/s | Collector CPU | Tempo CPU |
| ---------- | ------- | -----: | -----: | ----: | ----------: | -----------: | ------: | ------------: | --------: |
| peak-mix   | off     |    8.7 |   32.5 |   500 |         56% |          40% |       0 |          1.2% |      0.2% |
| peak-mix   | 10%     |    9.4 |   40.9 |   500 |         67% |          39% |     395 |          1.4% |      5.9% |
| peak-mix   | 100%    |   10.2 |   34.4 |   500 |         72% |          41% |   3,826 |          3.0% |     13.0% |
| traders-50 | off     |   19.1 |   41.2 |   462 |         73% |          86% |       0 |          1.0% |      0.2% |
| traders-50 | 10%     |   29.7 |   62.9 |   448 |         97% |          87% |     856 |          1.6% |      3.4% |
| traders-50 | 100%    |   45.7 |   92.8 |   435 |        111% |          92% |   8,197 |          5.2% |     24.9% |

Every arm, with its verdict against the catalog objective:

| Arm     | Scenario   | p95 ms | p99 ms | Req/s | Settled p99 ms | VM CPU stall | Verdict |
| ------- | ---------- | -----: | -----: | ----: | -------------: | -----------: | ------- |
| off-1   | peak-mix   |   11.3 |   45.1 |   500 |            159 |        10.4% | met     |
| off-1   | traders-50 |   21.4 |   44.5 |   460 |            192 |        10.3% | met     |
| on100-1 | peak-mix   |   11.9 |   35.7 |   500 |             95 |        11.3% | met     |
| on100-1 | traders-50 |   58.2 |  116.5 |   425 |            490 |        18.4% | missed  |
| on10-1  | peak-mix   |   10.5 |   53.5 |   500 |             93 |        10.0% | met     |
| on10-1  | traders-50 |   34.8 |   74.0 |   443 |            287 |        12.2% | missed  |
| on10-2  | peak-mix   |    8.3 |   28.4 |   500 |             87 |         8.8% | met     |
| on10-2  | traders-50 |   24.5 |   51.9 |   454 |            199 |        10.9% | met     |
| on100-2 | peak-mix   |    8.6 |   33.1 |   500 |             89 |         9.6% | met     |
| on100-2 | traders-50 |   33.1 |   69.1 |   446 |            391 |        14.8% | missed  |
| off-2   | peak-mix   |    6.1 |   19.9 |   500 |             77 |         7.2% | met     |
| off-2   | traders-50 |   16.9 |   37.8 |   464 |           179¹ |         9.7% | met     |

¹ Mimir shed this window's pipeline queries with HTTP 429 during the run. The value was
re-measured from the same window after the runner learned to retry.

## Findings

1. **At 500 req/s open-model, tracing costs CPU, not the SLO.** peak-mix met its objective
   in all six arms. oms-api CPU rose 20% at 10% sampling and 29% at 100%.
2. **Near saturation, the cost becomes latency.** In traders-50, p95 went from 19 ms to
   30 ms (10%) and 46 ms (100%), and throughput fell 3% and 6%. Each API replica runs one
   event loop, so extra work per request turns into queueing.
3. **The fixed cost dominates.** Off to 10% added 24 points of oms-api CPU in traders-50;
   10% to 100% added only 14 more. Unsampled requests still pass through the HTTP, Express
   and pg instrumentation. Cutting that is the next lever, not a lower ratio.
4. **The pipeline holds at 100%.** The collector lost nothing at 8,400 spans/s on 5% of a
   core. Tempo needs a quarter of a core at 100% against 3 to 6% at 10%. With
   `GOMEMLIMIT` it no longer OOMs while compacting; an earlier 100% run killed it at 1 GiB.
5. **Settlement lag follows API load.** traders-50 settled p99 was about 185 ms off, 243 ms
   at 10% and 440 ms at 100%.

## Runs discarded on the way

Two earlier attempts were thrown away, and each fixed the method:

- The disk filled mid-run and Docker went down; one arm saw only 3 of 12 container samples.
  The runner now marks such windows incomplete instead of averaging gaps.
- The next attempt measured while setup's orders were still flowing through the pipeline,
  on a book that grew by every previous run (295k resting orders by the end). Runs now
  start from empty state, drain setup and warm up before the window.
