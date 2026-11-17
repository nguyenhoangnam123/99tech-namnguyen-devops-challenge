# 0001: TypeScript on Node 22

**Status:** accepted

## Context

The brief names no language. 99Tech's other public challenges do: the backend-lead
starter "mirrors our real stack: TypeScript, Express, Sequelize, PostgreSQL, Jest", and
the CTO brief describes a TypeScript/Node modular monolith. Problem 3 is Node too.

## Decision

TypeScript (strict) on Node 22 LTS for every service. Express 5, Postgres, zod, and
decimal strings on the wire, as in their starter.

Deliberate differences, each with a reason:

- **Kysely, not Sequelize.** Ledger code needs explicit `FOR UPDATE` locks and
  visible transaction boundaries. A typed SQL builder shows both.
- **Vitest, not Jest.** ESM-native, no transform setup, same `expect` API.
- **bigint fixed point, not BigNumber.** Exact at the column's scale (1e-18), no
  global config, no dependency. Storage and wire format match their convention.

## Consequences

- Reviewers read the code natively, and the author can defend every line.
- Go would give a better tail latency for the matcher. At about 100 orders/s that does
  not matter, and the matcher sits behind a Kafka contract, so it can be rewritten later.
