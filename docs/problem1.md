# Problem 1: Building Castle In The Cloud

[README](../README.md) · Answer: [SOLUTION.md](../src/problem1/SOLUTION.md) · Next: [Problem 2](problem2.md)

A spot exchange built and tested locally first, then designed onto AWS. The local build
proves the hard parts (money correctness, exactly-once settlement, crash recovery and the
latency target); the design lifts the same services onto AWS.

## What the brief asks, and where it is answered

| The brief asks for                                    | Answer                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A highly available, scalable, cost-effective exchange | Accounts, limit and market orders, matching, a double-entry ledger and market data, built and tested locally ([README](../src/problem1/README.md)), then mapped onto three zones in AWS ([§1–3](../src/problem1/SOLUTION.md#1-the-assessment-tier-on-aws))        |
| An overview diagram of the services and their roles   | Two diagrams as code, the assessment tier ([§1](../src/problem1/SOLUTION.md#1-the-assessment-tier-on-aws)) and the production tier ([§8](../src/problem1/SOLUTION.md#8-production-tier-what-changes))                                                             |
| Why each service, and the alternatives considered     | Seven needs, each with the choice and the options rejected ([§4](../src/problem1/SOLUTION.md#4-why-each-service-and-what-else-was-considered))                                                                                                                    |
| Plans for scaling beyond the current setup            | 2x, 10x and 100x, each with its change, and the production tier with what triggers each step ([§8](../src/problem1/SOLUTION.md#scaling-plan))                                                                                                                     |
| 500 req/s with p99 under 100 ms                       | Measured locally: p99 51 ms at 500 req/s mixed, in the SLO catalog ([results](../src/problem1/reports/RESULTS.md#slo-catalog)). On AWS, a 60 ms budget for placing an order ([§5](../src/problem1/SOLUTION.md#5-latency-budget-p99--100-ms-for-placing-an-order)) |
| Beyond the brief                                      | Failure modes, cost (about $2,450 a month), production SLOs, and Terraform for the network and data tier, checked on a mocked AWS ([§6–10](../src/problem1/SOLUTION.md#6-failure-modes))                                                                          |

Open, and stated in the results: two closed-loop trading scenarios miss their objectives,
limited by API CPU and serial settlement per market (about 450 commands a second).

## Documents

| Document                                                           | What it covers                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [SOLUTION.md](../src/problem1/SOLUTION.md)                         | The AWS design: diagrams, service choices, latency budget, failure modes, cost, scaling, SLOs and Terraform      |
| [README.md](../src/problem1/README.md)                             | The local stack: architecture, how to run it, tests, results and known limits                                    |
| [docs/DEVELOPMENT.md](../src/problem1/docs/DEVELOPMENT.md)         | How the local stack fits together: startup order, generated code, the gates before a commit, telemetry, SLO runs |
| [docs/CONVENTIONS.md](../src/problem1/docs/CONVENTIONS.md)         | The three patterns used everywhere, and the tools that enforce them                                              |
| [docs/adr/](../src/problem1/docs/adr)                              | Five decisions: TypeScript, the service split, the matcher's command log, the ledger, abuse controls             |
| [reports/RESULTS.md](../src/problem1/reports/RESULTS.md)           | Test suites, the SLO catalog, the 500 req/s load test, an A/B, and the findings the suites caught                |
| [reports/slo/RESULTS.md](../src/problem1/reports/slo/RESULTS.md)   | Each SLO scenario, with CPU and memory for every container                                                       |
| [reports/slo/OVERHEAD.md](../src/problem1/reports/slo/OVERHEAD.md) | What tracing costs, and the sampling ratio chosen from it                                                        |
| [reports/security/](../src/problem1/reports/security)              | Abuse test output before and after the fixes, and the edge replica A/B                                           |
| [reports/zap/](../src/problem1/reports/zap)                        | OWASP ZAP API scan reports                                                                                       |
| [reports/tests/](../src/problem1/reports/tests)                    | Raw output of each test suite                                                                                    |
| [docs/aws/diagrams/](../src/problem1/docs/aws/diagrams)            | The AWS diagrams as code                                                                                         |
| [infra/](../src/problem1/infra)                                    | Terraform for the network and data tier, its tests and custom Checkov policies                                   |

## Check it yourself

Requires Docker, GNU make and Node 22 (the version is in `.nvmrc`). `make infra-check` also
needs Terraform 1.10 or later. `make perf` and `make security` rewrite the committed reports
in `reports/`; `git checkout -- reports` restores them.

```bash
cd src/problem1
npm ci
make up             # builds one image, starts 12 containers, waits until healthy
make test           # unit and property tests
make e2e            # contract and transaction tests against the stack
make chaos          # restart the matcher, kill the settler; books and ledger must survive
make security       # abuse tests and a ZAP API scan
make perf           # 500 req/s for 2 minutes
make infra-check    # Terraform on a mocked AWS, no account needed
make nuke           # stop everything and delete the data
```

CI runs these on every Problem 1 change, with a one-minute load smoke at 100 req/s in place
of the full load test: [p1-exchange](../.github/workflows/p1-exchange.yml).
