# 99Tech DevOps Challenge

| Problem                           | Status                                                                                                                                                                                                                                                                                               | Where                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1. Building Castle In The Cloud   | Wave 1: a working exchange with unit, contract, integration, e2e, chaos, abuse and load tests on a local stack. Wave 2: the AWS design, with diagrams, sizing from measurements, latency budget, failure modes and cost, plus Terraform for the network and data tier, tested in CI on a mocked AWS. | [src/problem1](src/problem1/SOLUTION.md) |
| 2. Diagnose Me Doctor             | Done: triage steps, causes with impact and recovery, and prevention. A read-only triage script and a lab that reproduces six causes and checks the script names each one.                                                                                                                           | [src/problem2](src/problem2/SOLUTION.md) |
| 3. Debugging issues within system | Done: eight root causes fixed, each with before and after evidence under load.                                                                                                                                                                                                                       | [src/problem3](src/problem3/SOLUTION.md) |
| 4. Ship It Twice                  | Done: backend and frontend pipelines with GitHub OIDC, applied and tested on AWS.                                                                                                                                                                                                                    | [src/problem4](src/problem4/SOLUTION.md) |
| 5. Fortify The Castle             | Done: threat model, priorities, and the Problem 1 design with changes marked. Built: the Terraform hardening, tested on a mocked AWS, and restricted ledger roles, tested against ledger attacks.                                                                                                    | [src/problem5](src/problem5/SOLUTION.md) |

## Assumptions about the brief

- The brief mentions role-specific subsets but lists none, so all five problems are attempted.
- Problem 3 refers to "the README in Problem 4 repo". Its files are in `src/problem3`; the
  folder was renamed when the original problem 1 was removed and the README kept the old title.
- Problem 2 asks for "two production issues" but describes one scenario. It is treated as one
  scenario with several possible root causes.
- GitHub runs workflows only from the repository root, so CI lives in `.github/workflows/`
  rather than under `src/problem4/.github/`.
