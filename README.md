# 99Tech DevOps Challenge

All five problems are attempted, and each has a `SOLUTION.md`. The checks in the CI table at
the end run in GitHub Actions whenever their problem changes.

| Problem                           | In one line                                                                                                                                                 | Answer                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1. Building Castle In The Cloud   | A working spot exchange, tested locally at 500 req/s, then designed onto AWS with diagrams, alternatives, latency budget, failure modes, cost and Terraform | [src/problem1](src/problem1/SOLUTION.md) |
| 2. Diagnose Me Doctor             | Read-only triage, eleven causes with impact and recovery, and a lab that reproduces six of them                                                             | [src/problem2](src/problem2/SOLUTION.md) |
| 3. Debugging issues within system | Eight root causes, each with evidence, a fix, and before and after results                                                                                  | [src/problem3](src/problem3/SOLUTION.md) |
| 4. Ship It Twice                  | Backend to EC2 and frontend to S3 through GitHub OIDC, applied and measured on AWS, then torn down                                                          | [src/problem4](src/problem4/SOLUTION.md) |
| 5. Fortify The Castle             | Problem 1 with security folded in and marked. The Terraform hardening and restricted ledger roles are built and tested                                      | [src/problem5](src/problem5/SOLUTION.md) |

## What each problem asks, and where it is answered

### 1. Building Castle In The Cloud

| The brief asks for                                    | Answer                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A highly available, scalable, cost-effective exchange | Accounts, limit and market orders, matching, a double-entry ledger and market data, built and tested locally ([README](src/problem1/README.md)), then mapped onto three zones in AWS ([§1–3](src/problem1/SOLUTION.md#1-the-assessment-tier-on-aws)) |
| An overview diagram of the services and their roles   | Two diagrams as code, the assessment tier ([§1](src/problem1/SOLUTION.md#1-the-assessment-tier-on-aws)) and the production tier ([§8](src/problem1/SOLUTION.md#8-production-tier-what-changes))                                                      |
| Why each service, and the alternatives considered     | Seven needs, each with the choice and the options rejected ([§4](src/problem1/SOLUTION.md#4-why-each-service-and-what-else-was-considered))                                                                                                          |
| Plans for scaling beyond the current setup            | 2x, 10x and 100x, each with its change, and the production tier with what triggers each step ([§8](src/problem1/SOLUTION.md#scaling-plan))                                                                                                           |
| 500 req/s with p99 under 100 ms                       | Measured locally: p99 51 ms at 500 req/s mixed ([results](src/problem1/reports/RESULTS.md)). On AWS, a 60 ms budget for placing an order ([§5](src/problem1/SOLUTION.md#5-latency-budget-p99--100-ms-for-placing-an-order))                          |
| Beyond the brief                                      | Failure modes, cost (about $2,450 a month), production SLOs, and Terraform for the network and data tier, checked on a mocked AWS ([§6–10](src/problem1/SOLUTION.md#6-failure-modes))                                                                |

Open, and stated in the results: two closed-loop trading scenarios miss their objectives,
limited by API CPU and serial settlement per market (about 450 commands a second).

### 2. Diagnose Me Doctor

| The brief asks for           | Answer                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How you would troubleshoot   | Look before deleting ([§1](src/problem2/SOLUTION.md#1-the-first-five-minutes-look-dont-delete)), then symptom to cause ([§2](src/problem2/SOLUTION.md#2-from-symptom-to-cause)). Scripted, read-only: [triage.sh](src/problem2/scripts/triage.sh)       |
| The causes you expect        | Eleven, from an unbounded cache to deleted files still held open ([§4](src/problem2/SOLUTION.md#4-causes-impact-recovery-prevention))                                                                                                                   |
| Impact and recovery for each | The same table, with recovery that never restarts NGINX. What clients see on a full disk, measured ([§3](src/problem2/SOLUTION.md#3-what-a-full-disk-does-to-traffic)); what to do at 100% ([§5](src/problem2/SOLUTION.md#5-if-it-is-at-100-right-now)) |
| Proof                        | A [lab](src/problem2/lab/RESULTS.md) reproduces six causes and checks that the script names each one and that recovery serves live traffic                                                                                                              |

### 3. Debugging issues within system

| The brief asks for       | Answer                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| What problems you found  | Eight faults, each with its effect and an evidence file ([root causes](src/problem3/SOLUTION.md#root-causes))                             |
| How you diagnosed them   | [How the faults were found](src/problem3/SOLUTION.md#how-the-faults-were-found)                                                           |
| The fixes you applied    | One fix per fault, with before and after results, most of them under load ([before and after](src/problem3/SOLUTION.md#before-and-after)) |
| Monitoring and alerts    | [Monitoring and alerts](src/problem3/SOLUTION.md#monitoring-and-alerts)                                                                   |
| Prevention in production | [Preventing this in production](src/problem3/SOLUTION.md#preventing-this-in-production)                                                   |

### 4. Ship It Twice

| The brief asks for                                | Answer                                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Design the pipelines                              | [Architecture](src/problem4/SOLUTION.md#architecture) and [the pipelines](src/problem4/SOLUTION.md#the-pipelines)                       |
| Implement them as GitHub Actions workflows        | Five `p4-*` workflows in [.github/workflows](.github/workflows), with the deploy logic in plain Bash                                    |
| Decide what "production ready" means, and meet it | Nine properties, each with how the pipelines provide it ([production ready](src/problem4/SOLUTION.md#what-production-ready-means-here)) |
| Assumptions and why                               | [Assumptions](src/problem4/SOLUTION.md#assumptions)                                                                                     |
| How the pipelines work, and what was left out     | [The pipelines](src/problem4/SOLUTION.md#the-pipelines), [left out on purpose](src/problem4/SOLUTION.md#left-out-on-purpose)            |
| Optional: a real AWS account                      | Applied for real: deploys and rollbacks measured on AWS ([evidence](src/problem4/SOLUTION.md#evidence)), then destroyed                 |

### 5. Fortify The Castle

| The brief asks for                                            | Answer                                                                                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The updated architecture, with security changes marked        | A new diagram: green added, amber changed ([§1](src/problem5/SOLUTION.md#1-the-updated-architecture))                                                                                               |
| Security as part of the design: changed, added, accepted      | Layer by layer, each change marked Changed, Added or Accepted ([§5](src/problem5/SOLUTION.md#5-changes-layer-by-layer))                                                                             |
| Why each change, and what it protects against                 | The assets at stake ([§3](src/problem5/SOLUTION.md#3-what-is-worth-stealing-or-breaking)), then the threat beside each change in §5                                                                 |
| What first, what deferred, what you refuse to ship without    | [§4](src/problem5/SOLUTION.md#4-priorities)                                                                                                                                                         |
| Facts you don't have: what, how to get them, what you assumed | [§2](src/problem5/SOLUTION.md#2-facts-i-dont-have)                                                                                                                                                  |
| What was left out, and the trade-offs                         | [§7](src/problem5/SOLUTION.md#7-left-out-and-the-trade-offs)                                                                                                                                        |
| Beyond the brief                                              | Built and tested: the Terraform hardening (Checkov findings 23 to 7) and ledger roles that refuse all 9 ledger attacks, of which wave 1's role allows 6 ([§6](src/problem5/SOLUTION.md#6-evidence)) |

## Continuous integration

| Workflow                                               | What it runs                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `p1-exchange`                                          | Lint, types and contracts; unit and property tests; e2e, chaos, abuse, ZAP and a load smoke; Terraform on a mocked AWS; 37 deliberate breaks |
| `p2-disk`                                              | shellcheck, then each lab scenario                                                                                                           |
| `p4-backend`, `p4-frontend`, `p4-deploy-*`, `p4-infra` | Problem 4's pipelines and infrastructure checks. Steps that sign in to AWS need its account recreated first                                  |
| `p5-security`                                          | The ledger attacks against the restricted roles                                                                                              |
| `workflows-lint`                                       | actionlint and zizmor on every workflow                                                                                                      |

## Assumptions about the brief

- The brief mentions role-specific subsets but lists none, so all five problems are attempted.
- Problem 3 refers to "the README in Problem 4 repo". Its files are in `src/problem3`; the
  folder was renamed when the original problem 1 was removed and the README kept the old title.
- Problem 2 asks for "two production issues" but describes one scenario. It is treated as one
  scenario with several possible root causes.
- GitHub runs workflows only from the repository root, so CI lives in `.github/workflows/`
  rather than under `src/problem4/.github/`.
