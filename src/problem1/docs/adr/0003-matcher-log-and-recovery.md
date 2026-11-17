# 0003: The command log is the matcher's source of truth

**Status:** accepted

## Decision

- Commands are keyed by symbol, so one partition orders a market.
- The matcher publishes each command's events and commits the consumed offset in one
  Kafka transaction. "Processed" means exactly "events published".
- On start it replays commands up to the committed offset to rebuild the books in memory.
  The engine is pure and deterministic, so the rebuilt books are identical.
- A fixed `transactional.id` fences any older instance still running.
- After any failed batch the matcher refuses all further work and restarts. The books
  had already advanced in memory, so only a replay can make them consistent again.
- One command fills at most 500 makers. The remainder expires with `FILL_LIMIT`, which
  bounds the event batch size; a sweep of dust orders cannot exceed Kafka's message limit.

## Rejected

- **At-least-once with deterministic ids only.** Safe downstream, but it leaves the
  matcher's own recovery point ambiguous.
- **Matching inside Postgres.** Row locks on the book serialise everything, and price-time
  priority becomes a query rather than a data structure.
- **Raft-replicated engine (Aeron Cluster style).** Lower failover time, much more machinery.
  This is the wave 2 option if replay time becomes the availability bottleneck.

## Consequences

- Recovery time grows with the log. Wave 2 adds periodic book snapshots so replay starts
  from the latest snapshot. Locally, `retention.ms=-1` keeps the full log.
- A hot standby would replay continuously and take over on fencing; today a restart is a
  cold replay (seconds at this volume).
