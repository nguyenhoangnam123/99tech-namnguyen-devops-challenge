# 0002: Three services, split by failure and scaling profile

**Status:** accepted

## Context

500 rps with roughly 20% writes is about 100 orders/s. A single in-memory matching engine
handles orders of magnitude more. The hard problems are correctness and recovery, not throughput.
Every extra service adds a network hop to the 100 ms budget and a distributed transaction around money.

## Decision

| Service | Owns | Why separate |
|---|---|---|
| `oms` | Auth, balances, ledger, orders, settlement (Postgres) | Every money change happens in one ACID database |
| `matcher` | Order books in memory | One stateful, deterministic writer; scales by splitting symbols |
| `marketdata` | Depth, trades, ticker, WebSocket | Scales with connected clients; can lag without losing money |

`oms` runs as three roles from one image: `api` (stateless, scales out), `relay` (outbox to
Kafka) and `settler` (Kafka to ledger). Their failure modes differ, so they restart independently.

## Rejected

- **Separate auth, wallet and risk services.** Each would sit inside the order path's
  transaction. Revisit when a team owns each.
- **A monolith including the matcher.** Matching availability would be tied to API deploys,
  and WebSocket fan-out would compete with order placement for CPU.

## Consequences

- Placing an order is one Postgres transaction. Matching and settlement are asynchronous,
  so a client sees `NEW` immediately and fills a few milliseconds later.
- All settlement funnels through the USDT fee account row. That is fine at this scale;
  the scaling plan replaces it with sharded fee accounts.
