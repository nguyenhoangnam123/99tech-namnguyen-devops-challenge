# 99Tech DevOps Challenge

All five problems are attempted. Each has a guide in [docs/](docs) that maps the brief to
its answer, and a `SOLUTION.md` with the answer itself. The checks run in GitHub Actions
whenever their problem changes.

| Guide                                                 | In one line                                                                                                                                                 | Answer                                  | CI                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [1. Building Castle In The Cloud](docs/problem1.md)   | A working spot exchange, tested locally at 500 req/s, then designed onto AWS with diagrams, alternatives, latency budget, failure modes, cost and Terraform | [SOLUTION.md](src/problem1/SOLUTION.md) | [![p1-exchange](https://github.com/nguyenhoangnam123/99tech-namnguyen-devops-challenge/actions/workflows/p1-exchange.yml/badge.svg)](https://github.com/nguyenhoangnam123/99tech-namnguyen-devops-challenge/actions/workflows/p1-exchange.yml) |
| [2. Diagnose Me Doctor](docs/problem2.md)             | Read-only triage, eleven causes with impact and recovery, and a lab that reproduces six of them                                                             | [SOLUTION.md](src/problem2/SOLUTION.md) | [![p2-disk](https://github.com/nguyenhoangnam123/99tech-namnguyen-devops-challenge/actions/workflows/p2-disk.yml/badge.svg)](https://github.com/nguyenhoangnam123/99tech-namnguyen-devops-challenge/actions/workflows/p2-disk.yml)             |
| [3. Debugging issues within system](docs/problem3.md) | Eight root causes, each with evidence, a fix, and before and after results                                                                                  | [SOLUTION.md](src/problem3/SOLUTION.md) | No workflow; see its [evidence](src/problem3/evidence)                                                                                                                                                                                         |
| [4. Ship It Twice](docs/problem4.md)                  | Backend to EC2 and frontend to S3 through GitHub OIDC, applied and measured on AWS, then torn down                                                          | [SOLUTION.md](src/problem4/SOLUTION.md) | [![p4-infra](https://github.com/nguyenhoangnam123/99tech-namnguyen-devops-challenge/actions/workflows/p4-infra.yml/badge.svg)](https://github.com/nguyenhoangnam123/99tech-namnguyen-devops-challenge/actions/workflows/p4-infra.yml)          |
| [5. Fortify The Castle](docs/problem5.md)             | Problem 1 with security folded in and marked. The Terraform hardening and restricted ledger roles are built and tested                                      | [SOLUTION.md](src/problem5/SOLUTION.md) | [![p5-security](https://github.com/nguyenhoangnam123/99tech-namnguyen-devops-challenge/actions/workflows/p5-security.yml/badge.svg)](https://github.com/nguyenhoangnam123/99tech-namnguyen-devops-challenge/actions/workflows/p5-security.yml) |

## How to read it

1. **This page:** what each problem delivers.
2. **The problem's guide:** each item the brief asks for and the section that answers it,
   every document for that problem, and how to check it yourself.
3. **The problem's `SOLUTION.md`:** the answer itself.

[docs/ci.md](docs/ci.md) lists every workflow, what it runs and when.

## Repository layout

```text
.github/workflows/   CI workflows, listed in docs/ci.md
docs/                a guide per problem, and the CI overview
src/problem1/        the exchange: services, contracts, deploy, Terraform, reports
src/problem2/        the triage script and the lab
src/problem3/        the fixed compose stack, evidence and chaos script
src/problem4/        the two apps, Terraform and deploy scripts
src/problem5/        the security review, ledger roles and their test
```

## Assumptions about the brief

- The brief mentions role-specific subsets but lists none, so all five problems are attempted.
- Problem 3's task is titled "Problem 4" and refers to "the README in Problem 4 repo". It is
  taken to mean the files in `src/problem3`.
- Problem 2 asks for "two production issues" but describes one scenario. It is treated as one
  scenario with several possible root causes.
- GitHub runs workflows only from the repository root, so CI lives in `.github/workflows/`
  rather than under `src/problem4/.github/`.
