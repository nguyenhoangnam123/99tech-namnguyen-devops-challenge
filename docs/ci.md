# Continuous integration

[README](../README.md)

Workflows run on pull requests and on pushes to `main`, only when the paths in the table
change. The two `p4-deploy-*` workflows run only when called by another workflow or by hand.
GitHub runs workflows only from the repository root, so they live in
[.github/workflows](../.github/workflows) rather than under `src/problem4/.github/`.

| Workflow                                                                                                                           | Runs when these change                               | What it runs                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [p1-exchange](../.github/workflows/p1-exchange.yml)                                                                                | `src/problem1/`                                      | Lint, types and contracts; unit and property tests; e2e, chaos, abuse, ZAP and a load smoke; Terraform on a mocked AWS; 37 deliberate breaks |
| [p2-disk](../.github/workflows/p2-disk.yml)                                                                                        | `src/problem2/`                                      | shellcheck, then each lab scenario except the privileged LVM one                                                                             |
| [p4-backend](../.github/workflows/p4-backend.yml), [p4-frontend](../.github/workflows/p4-frontend.yml)                             | `src/problem4/apps/`, `src/problem4/scripts/`        | Checks on pull requests; on `main`, build and publish once, then deploy to staging and production                                            |
| [p4-deploy-backend](../.github/workflows/p4-deploy-backend.yml), [p4-deploy-frontend](../.github/workflows/p4-deploy-frontend.yml) | Called by the two above, or run by hand to roll back | One deploy to one environment                                                                                                                |
| [p4-infra](../.github/workflows/p4-infra.yml)                                                                                      | `src/problem4/infra/`                                | fmt, validate, tflint and Checkov; Terratest plans when AWS is set up                                                                        |
| [p5-security](../.github/workflows/p5-security.yml)                                                                                | `src/problem5/`, Problem 1's migrations              | The ledger attacks against the restricted roles                                                                                              |
| [workflows-lint](../.github/workflows/workflows-lint.yml)                                                                          | `.github/workflows/`                                 | actionlint and zizmor on every workflow                                                                                                      |

Problem 4's AWS resources were destroyed after its evidence was recorded. Steps that sign
in to AWS need them recreated first ([Running it](../src/problem4/SOLUTION.md#running-it)).
Problem 3 has no workflow; its [evidence](../src/problem3/evidence) holds the runs.
