# Problem 5: Fortify The Castle

[README](../README.md) · Answer: [SOLUTION.md](../src/problem5/SOLUTION.md) · Previous: [Problem 4](problem4.md)

A security review of the Problem 1 design, with each fix folded in and marked as changed,
added or accepted.

## What the brief asks, and where it is answered

| The brief asks for                                            | Answer                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The updated architecture, with security changes marked        | A new diagram: green added, amber changed ([§1](../src/problem5/SOLUTION.md#1-the-updated-architecture))                                                                                                                                                                                                                         |
| Security as part of the design: changed, added, accepted      | Layer by layer, each change marked Changed, Added or Accepted ([§5](../src/problem5/SOLUTION.md#5-changes-layer-by-layer))                                                                                                                                                                                                       |
| Why each change, and what it protects against                 | The assets at stake ([§3](../src/problem5/SOLUTION.md#3-what-is-worth-stealing-or-breaking)), then the threat beside each change in §5                                                                                                                                                                                           |
| What first, what deferred, what you refuse to ship without    | [§4](../src/problem5/SOLUTION.md#4-priorities)                                                                                                                                                                                                                                                                                   |
| Facts you don't have: what, how to get them, what you assumed | [§2](../src/problem5/SOLUTION.md#2-facts-i-dont-have)                                                                                                                                                                                                                                                                            |
| What was left out, and the trade-offs                         | [§7](../src/problem5/SOLUTION.md#7-left-out-and-the-trade-offs)                                                                                                                                                                                                                                                                  |
| Beyond the brief                                              | Built and tested: the Terraform hardening (Checkov findings 23 to 7) and ledger roles that refuse all 9 ledger attacks, of which wave 1's role allows 6. One gap stays open: the services can still change a balance directly ([§5.4](../src/problem5/SOLUTION.md#54-data-stores), [§6](../src/problem5/SOLUTION.md#6-evidence)) |

## Documents

| Document                                                 | What it covers                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [SOLUTION.md](../src/problem5/SOLUTION.md)               | The review: diagram, missing facts, assets, priorities, changes, evidence, trade-offs            |
| [img/aws-secure.png](../src/problem5/img/aws-secure.png) | The updated architecture, rendered from [diagrams/secure.py](../src/problem5/diagrams/secure.py) |
| [sql/roles.sql](../src/problem5/sql/roles.sql)           | The restricted ledger roles                                                                      |
| [sql/test-roles.sh](../src/problem5/sql/test-roles.sh)   | Tries each ledger attack as wave 1's role and as the restricted roles                            |
| [Problem 1 infra/](../src/problem1/infra)                | The hardened Terraform; the security diff is `git diff 147052e -- src/problem1/infra`            |

## Check it yourself

Requires Docker and GNU make.

```bash
cd src/problem5
make test-roles    # the ledger attacks against each role
make diagram       # re-render img/aws-secure.png
```

The Terraform hardening is checked by Problem 1's `make infra-check`. CI runs the ledger
attacks on every Problem 5 change: [p5-security](../.github/workflows/p5-security.yml).
