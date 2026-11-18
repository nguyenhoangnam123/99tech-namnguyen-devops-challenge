# Problem 3: an unreliable API

Eight faults left the API either unreachable or one dependency hiccup away from an outage.
After the fixes, errors last only as long as the disruption does (under 30 requests for a
restart), no request waits more than about 6 s, and the stack recovers on its own.

## Before and after

The load rows use [scripts/chaos.sh](scripts/chaos.sh): 50 req/s on `/api/users` through
nginx for 60 s, with one disruption at 15 s. "Before" is the original code with only the
port fixed, except for the frozen-Postgres row, which ran after fixes 1 to 7. The other rows
are single commands, shown in the evidence files. Raw output is in [evidence/](evidence).

| Disruption | Before | After |
| --- | --- | --- |
| None | every `/api/` request 502 | 100% ok, p99 8 ms |
| Postgres restart | API crashed and stayed down: 25.0% ok; the rest 502, 504 after 60 s, or no answer | 99.4% ok: 19 errors, all in the 5 s after the restart |
| Queries cancelled for 10 s | connection pool leaked and the API hung for good: 25.3% ok | requests inside the window fail (83.4% ok), then full recovery |
| Redis down for 15 s | every request stalled until Redis returned (p99 15.6 s), or 533 failed after 10 s | 100% ok, max 99 ms |
| Postgres frozen for 20 s | requests holding a connection waited out the freeze: max 20.3 s | requests fail within 6 s; none waits longer |
| API back at a new address | 0% ok until nginx was restarted by hand | nginx follows the new address |
| nginx restarted while the API is down | nginx refuses to start; `/` is down too | nginx runs; `/` 200, `/api/` 502 in 6 ms |
| `docker compose stop api` | 10.3 s, then SIGKILL (exit 137) | 0.4 s, exit 0; 8.3 s if a request never finishes |
| API process killed | stays down: no restart policy | running again 3 s later |

## Root causes

| # | Fault | Effect | Evidence | Fix |
| --- | --- | --- | --- | --- |
| 1 | nginx proxies `/api/` to port 3001; the API listens on 3000 | every API request 502 | [01](evidence/01-port-mismatch.txt) | proxy to 3000 |
| 2 | The `pg` pool has no `error` listener. A Postgres restart drops idle connections, Node treats the unhandled event as fatal, and the process exits | API crashes on any Postgres restart or failover | [02](evidence/02-postgres-restart-crashes-api.txt) | log pool errors instead of crashing |
| 3 | No restart policy on any service | one crash is an outage until someone notices | [02](evidence/02-postgres-restart-crashes-api.txt) | `restart: unless-stopped` |
| 4 | The `last_call` write to Redis sits on the response path, and ioredis queues and retries it 20 times while Redis is down | a Redis outage stalls or fails requests, though the response never uses Redis | [03](evidence/03-redis-outage-fails-requests.txt) | best-effort write: no offline queue, 500 ms timeout, response does not wait |
| 5 | `db.release()` is skipped when a query throws, and `pool.connect()` waits forever by default | ten failed queries hold all ten connections; every later request hangs | [04](evidence/04-failed-queries-leak-the-pool.txt) | `pool.query`, which always releases; pool waits capped at 2 s, statements at 5 s |
| 6 | nginx resolves `api` once, at startup. The same static `proxy_pass` makes nginx refuse to start while `api` cannot be resolved | an API at a new address gets none of the traffic; a down API plus an nginx restart takes `/` down too | [05](evidence/05-nginx-stale-upstream-address.txt) | Docker DNS as resolver, re-asked every 5 s, via a variable `proxy_pass` |
| 7 | Node runs as PID 1 with no SIGTERM handler, so the signal is ignored | every stop or deploy waits 10 s, then kills in-flight requests | [06](evidence/06-api-ignores-sigterm.txt) | SIGTERM closes the server, then the pools; forced exit at 8 s |
| 8 | No client-side bound on database calls. `statement_timeout` is enforced by Postgres, so a frozen server or dead network path never applies it | requests wait as long as the freeze lasts; past 60 s, nginx 504s | [08](evidence/08-frozen-postgres-holds-requests.txt) | `query_timeout` of 6 s in the client; nginx timeouts (below) |

### Timeouts

Every wait is bounded, and each layer allows more than the one below it:

| Layer | Limit |
| --- | --- |
| API: wait for a pool connection | 2 s |
| Postgres: `statement_timeout` (fires first whenever Postgres can answer) | 5 s |
| API: `query_timeout` (for when Postgres cannot answer) | 6 s |
| nginx: connect / read | 2 s / 10 s |

So the API answers within 8 s, and nginx cuts off only an API that is stuck. With one
replica, a cut-off request fails instead of succeeding late. That is deliberate: a bounded
answer beats holding the client, and an nginx connection, for 60 s. With more replicas, the
same timeouts let nginx retry on another one.

### Hardening applied alongside

- **Healthchecks and start order.** `depends_on` only ordered container starts. Every service
  now has a healthcheck; Postgres is checked over TCP, because during first-run init it
  answers only on its socket. The API waits for Postgres and Redis, nginx for the API.
- **Credentials from the environment.** The password was in the API code and compose; it now
  comes from `.env`. That file is committed so `docker compose up --build` works as the brief
  says, and holds a local-only value. Postgres reads it only when it initialises an empty
  data directory.
- **Unused config removed.** The empty `nginx/nginx.conf` and `postgres/init.sql` were never
  mounted. Applying init.sql's 20-connection cap would leave no room for a second API replica
  with a 10-connection pool, so the default stays.
- **Repeatable image builds.** A lockfile and `npm ci` replace `npm install`, the
  `node:20-alpine` base is pinned by digest, and the API runs as the `node` user.
- **Quiet failure logs.** Failed `last_call` writes are counted and logged once every 10 s,
  not once per request.

## How the faults were found

1. **Through the front door first.** `curl` via nginx gave 502 on `/api/` and 200 on `/`.
   The nginx error log named the upstream it tried (`172.27.0.4:3001`), and calling the API
   inside its container on 3000 worked: fault 1.
2. **Steady load with one disruption at a time.** [scripts/chaos.sh](scripts/chaos.sh) runs
   k6 at a constant arrival rate, so an outage shows up as failed or missing requests instead
   of a slower load generator. It prints status counts and p99 per 5 s, and marks when the
   disruption ran. The disruptions are the everyday ones: a database restart or freeze,
   failing queries, a cache outage, a redeploy.
3. **Each failure traced to its cause:**
   - API logs: the stack trace ends in `pg-pool` `idleListener`, an unhandled `error` event
     (fault 2).
   - `docker inspect`: exit code 1, restart count 0, restart policy `no` (fault 3).
   - API logs during the Redis outage: `MaxRetriesPerRequestError` on every failed request
     (fault 4).
   - `pg_stat_activity` after cancelled queries: the API holds 10 connections, all idle,
     while requests hang (fault 5).
   - After the API came back at `.6`, `getent hosts api` inside nginx returned `.6` while
     nginx kept connecting to `.4`. A redeploy then moved it back to `.4`, and nginx sent
     every request to `.6` (fault 6).
   - `docker compose stop api` takes 10.3 s and exits 137 (fault 7).
   - With Postgres paused, the requests already holding a connection waited 20.3 s, the length
     of the pause, while the others hit the 2 s pool wait (fault 8).
4. **The same runs after the fixes**, with the exact commands, in
   [evidence/07-after-fixes.txt](evidence/07-after-fixes.txt).

## Monitoring and alerts

| Signal | Alert when | Catches |
| --- | --- | --- |
| Synthetic `GET /api/users` through nginx every 30 s | 2 failures in a row, or success under 99% over 10 min | 1, 2, 5, 6, 8 |
| nginx 5xx ratio by upstream status, upstream response time p99 (access log with `$upstream_addr`, `$upstream_status`, `$upstream_response_time`) | 5xx over 1% for 5 min, or p99 over 500 ms | 1, 4, 5, 6, 8 |
| Container restarts, exit codes, OOM kills, health status | any restart in 10 min; exit 137 on a planned stop; unhealthy for 1 min | 2, 3, 7 |
| `pg` pool total, idle and waiting clients; pool connect and query timeouts | waiting over 0 for 1 min; any timeout | 5, 8 |
| Postgres connections by state and application, share of `max_connections` | over 80%, or the API holding its full pool while idle | 5 |
| Redis availability; failed `last_call` writes | Redis down 1 min; failed writes for 5 min | 4 |
| Error logs: unhandled `error` events, uncaught exceptions, process exits | any | 2, 3 |

## Preventing this in production

- **More than one API replica, behind health-checked routing.** With one replica, a redeploy
  still costs a burst of errors (26 requests in evidence 07). With two or more, add
  `proxy_next_upstream` so nginx retries idempotent requests on another replica.
- **An orchestrator with liveness and readiness probes** (ECS, Kubernetes). Compose only
  orders startup; it does not restart an unhealthy container.
- **Service discovery, not addresses resolved once.** The port and host the proxy uses should
  come from the same source as the app's listen port; CI runs `nginx -t` and a smoke test
  through the proxy.
- **Failure tests in CI.** `scripts/chaos.sh` against the compose stack, with a pass
  threshold per disruption, turns each fault above into a regression test.
- **Code rules that make these faults hard to write:** `pool.query` or `release()` in
  `finally`; a listener on every client's `error` event; a client-side timeout on every
  dependency call; lint for floating promises; SIGTERM handling in the service template.
- **Supply chain and secrets:** lockfiles and digest-pinned base images, kept current by
  Renovate or Dependabot; non-root containers; credentials from a secret manager, not `.env`.

## Running it

```bash
docker compose up -d --build --wait     # returns once every service is healthy
curl localhost:8080/api/users
scripts/chaos.sh restart-postgres       # needs k6 and Node; see the script for actions
```
