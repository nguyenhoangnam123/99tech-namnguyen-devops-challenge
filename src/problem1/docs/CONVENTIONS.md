# Conventions

Three patterns, applied everywhere. Each one is enforced by a tool, not by memory,
because a rule that lives only in a document is the first one skipped under pressure.

## 1. Functional core, imperative shell

`packages/core` holds every rule that moves money or matches orders: validation,
the matching engine, ledger journals, settlement, the market-data projection.

- No I/O, no clock, no randomness. Time and ids come in as arguments.
- Business outcomes are values (`Result<T, E>`). Exceptions mean a broken invariant.
- Services are split into `app/` (use cases that call core and their own ports),
  `adapters/` (Postgres, Kafka, HTTP, crypto) and `main.ts` (wiring).

**Why:** the code that moves money can be read and tested in milliseconds without a
stack. Determinism is what makes crash replay and A/B comparisons possible.

**Enforced by:**
- `tsconfig` for core has `types: []`, so `process`, `Buffer` and timers do not compile.
- ESLint bans `Date.now()`, `new Date()`, `Math.random` and float literals in core.
- dependency-cruiser: core imports nothing; `app/` imports only core and its own ports;
  platform knows no domain; no service imports another.

## 2. Contract-first

`contracts/` is the source of truth. Code is generated from it, never the other way round.

| Contract | Source | Generated |
|---|---|---|
| REST | `contracts/openapi/*.yaml` | `packages/contracts/src/gen/openapi` (openapi-typescript) |
| Events | `contracts/proto/**/*.proto` | `packages/contracts/src/gen/proto` (protobuf-es) |
| Database | `contracts/db/migrations/*.sql` | `packages/contracts/src/gen/db.ts` (kysely-codegen) |

- HTTP routes are registered from the spec's `operationId`s. A spec operation without
  a handler fails at boot; a handler returning a body the spec does not allow fails to compile.
- Requests are validated against the spec at runtime. Responses are too, outside production.
- Kafka payloads cross the boundary only through `packages/codecs`.

**Why:** one file shows a reader the whole interface, and a guessed field name
fails at compile time instead of in production.

**Enforced by:** `make check-gen` (CI fails on stale generated code), `buf lint`,
`buf breaking`, and the platform test that compiles every spec in the validator.

## 3. Idempotent command → event handlers, outbox and inbox

- Every write carries an idempotency key: `clientOrderId`, the custody `txId`,
  the command id, or the event id derived from it.
- A state change and the message announcing it commit together (outbox).
- Every consumer remembers what it applied (inbox table, or the matcher's Kafka
  transaction), so redelivery and replay are no-ops.
- The matcher is deterministic, so a replay reproduces the same trade ids.

**Why:** retries, duplicates and crashes are normal. Making them safe by construction
removes the class of bug that distributed money code most often gets subtly wrong.

**Enforced by:** the e2e and integration suites hammer each write path with concurrent
duplicates, and the ledger invariants run after every e2e file.

## Code style

- Comments: at most 3 lines of 10 to 15 words. Say why, not what.
  Longer reasoning goes in an ADR or the commit message.
- Money is `bigint` in units of 1e-18 (`NUMERIC(36,18)` in Postgres, decimal strings on the wire).
- Errors leave the API as RFC 9457 problems with a machine `code`.
- `max-lines` 300 and `complexity` 12 per function, enforced by ESLint.
