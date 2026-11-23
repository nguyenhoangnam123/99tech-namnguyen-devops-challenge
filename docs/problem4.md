# Problem 4: Ship It Twice

[README](../README.md) · Answer: [SOLUTION.md](../src/problem4/SOLUTION.md) · Previous: [Problem 3](problem3.md) · Next: [Problem 5](problem5.md)

GitHub Actions pipelines for a backend API on EC2 and a single-page app on S3, signing in to
AWS through OpenID Connect.

## What the brief asks, and where it is answered

| The brief asks for                                | Answer                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Design the pipelines                              | [Architecture](../src/problem4/SOLUTION.md#architecture) and [the pipelines](../src/problem4/SOLUTION.md#the-pipelines)                    |
| Implement them as GitHub Actions workflows        | Five `p4-*` workflows in [.github/workflows](../.github/workflows), with the deploy logic in plain Bash                                    |
| Decide what "production ready" means, and meet it | Nine properties, each with how the pipelines provide it ([production ready](../src/problem4/SOLUTION.md#what-production-ready-means-here)) |
| Assumptions and why                               | [Assumptions](../src/problem4/SOLUTION.md#assumptions)                                                                                     |
| How the pipelines work, and what was left out     | [The pipelines](../src/problem4/SOLUTION.md#the-pipelines), [left out on purpose](../src/problem4/SOLUTION.md#left-out-on-purpose)         |
| Optional: a real AWS account                      | Applied for real: deploys and rollbacks measured on AWS ([evidence](../src/problem4/SOLUTION.md#evidence)), then destroyed                 |

## Documents

| Document                                                                                                                           | What it covers                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [SOLUTION.md](../src/problem4/SOLUTION.md)                                                                                         | Production ready, architecture, pipelines, tests, evidence, assumptions and what was left out |
| [p4-backend](../.github/workflows/p4-backend.yml), [p4-frontend](../.github/workflows/p4-frontend.yml)                             | Check, build and publish once, then deploy to staging and production                          |
| [p4-deploy-backend](../.github/workflows/p4-deploy-backend.yml), [p4-deploy-frontend](../.github/workflows/p4-deploy-frontend.yml) | One deploy to one environment, also used to roll back                                         |
| [p4-infra](../.github/workflows/p4-infra.yml)                                                                                      | Terraform checks and plan tests                                                               |
| [scripts/](../src/problem4/scripts)                                                                                                | The deploy logic in Bash: image push, instance refresh, asset upload, smoke test              |
| [infra/](../src/problem4/infra)                                                                                                    | Terraform for the shared stack and each environment, Terratest, custom Checkov policies       |
| [apps/](../src/problem4/apps)                                                                                                      | The backend and frontend being shipped                                                        |

## Check it yourself

The AWS resources were destroyed after the evidence was recorded.
[Running it](../src/problem4/SOLUTION.md#running-it) recreates them. Without AWS, with Node,
Terraform and Docker:

```bash
cd src/problem4
make test          # lint, typecheck and test both apps
make lint-infra    # fmt, validate, tflint and Checkov on every stack
```
