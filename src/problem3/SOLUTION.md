# Problem 3: an unreliable API

Seven faults made the API either unreachable or one dependency hiccup away from an outage.
After the fixes, each failure that used to take `/api/users` down now costs at most a
second of errors, and the stack recovers on its own.

## Before and after

The load rows use [scripts/chaos.sh](scripts/chaos.sh): 50 req/s on `/api/users` through
nginx for 60 s, with one disruption at t=15 s. The last two rows are single commands. Raw
output is in [evidence/](evidence).

| Disruption | Before | After |
| --- | --- | --- |
| None | every `/api/` request 502 | 100% ok, p99 9 ms |
| Postgres restart | API crashed and stayed down: 24.7% ok, the rest 502, 504 after 60 s, or no answer | 99.5% ok; 16 errors within a second |
| Queries cancelled for 10 s | connection pool leaked; API hung for good: 24.8% ok | only requests inside the window fail (83.3% ok); full recovery right after |
| Redis down for 15 s | requests hung 10 s, then 535 failed: 82.2% ok, p99 10.1 s | 100% ok, p99 10 ms |
| API redeployed to a new address | 0% ok until nginx was restarted by hand | nginx follows the new address; 35 errors within a second |
| `docker compose stop api` | 10.6 s, then SIGKILL (exit 137) | 0.6 s, exit 0 |
| API process killed | stays down: no restart policy | restarted within a second |

## Root causes

| # | Fault | Effect | Evidence | Fix |
| --- | --- | --- | --- | --- |
| 1 | nginx proxies `/api/` to port 3001; the API listens on 3000 | every API request 502 | [01](evidence/01-port-mismatch.txt) | proxy to 3000 |
| 2 | The `pg` pool has no `error` listener. A Postgres restart drops idle connections, Node treats the unhandled event as fatal, and the process exits | API crashes on any Postgres restart or failover | [02](evidence/02-postgres-restart-crashes-api.txt) | log pool errors instead of crashing |
| 3 | No restart policy on any service | one crash is an outage until someone notices | [02](evidence/02-postgres-restart-crashes-api.txt) | `restart: unless-stopped` |
| 4 | The `last_call` write to Redis sits on the response path, and ioredis queues and retries it 20 times while Redis is down | a Redis outage hangs requests, then fails them, though the response never uses Redis | [03](evidence/03-redis-outage-fails-requests.txt) | best-effort write: no offline queue, 500 ms timeout, response does not wait |
| 5 | `db.release()` is skipped when a query throws, and `pool.connect()` waits forever by default | ten failed queries hold all ten connections; every later request hangs | [04](evidence/04-failed-queries-leak-the-pool.txt) | `pool.query`, which always releases; pool waits capped at 2 s, statements at 5 s |
| 6 | nginx resolves `api` once at startup | a redeploy that moves the API to a new address sends every request to the old one | [05](evidence/05-nginx-stale-upstream-address.txt) | Docker DNS as resolver, re-asked every 5 s |
| 7 | Node runs as PID 1 with no SIGTERM handler, so the signal is ignored | every stop or deploy waits 10 s, then kills in-flight requests | [06](evidence/06-api-ignores-sigterm.txt) | SIGTERM closes the server, then the pools |

Hardening applied alongside, for faults that would surface under other conditions:

- **Healthchecks and start order**. `depends_on` only ordered container starts.
  Each service now has a healthcheck; Postgres is checked over TCP, because during first-run
  init it answers only on its socket. The API waits for Postgres and Redis, nginx for the API.
- **Credentials from the environment**. The password was in the API code and
  compose; it now comes from `.env`.
- **Unused config removed**. The empty `nginx/nginx.conf` and `postgres/init.sql`
  were never mounted. Applying init.sql's 20-connection cap would leave no room for a second
  API replica with a 10-connection pool, so the default stays.
- **Reproducible image**. A lockfile and `npm ci` replace `npm install`; the
  API runs as the `node` user.

## How the faults were found

1. **Through the front door first.** `curl` via nginx gave 502 on `/api/` and 200 on `/`.
   The nginx error log named the upstream it tried (`172.27.0.4:3001`), and calling the API
   inside its container on 3000 worked: fault 1.
2. **Steady load with one disruption at a time.** [scripts/chaos.sh](scripts/chaos.sh) runs
   k6 at a constant arrival rate, so an outage shows up as failed or missing requests instead
   of a slower load generator. It prints status counts and p99 per 5 s. The disruptions are
   the everyday ones: a database restart, failing queries, a cache outage, a redeploy.
3. **Each failure traced to its cause:**
   - API logs: the stack trace ends in `pg-pool` `idleListener`, an unhandled `error` event
     (fault 2).
   - `docker inspect`: exit code 1, restart count 0, restart policy `no` (fault 3).
   - API logs during the Redis outage: `MaxRetriesPerRequestError` on every failed request
     (fault 4).
   - `pg_stat_activity` after cancelled queries: the API holds 10 connections, all idle,
     while requests hang (fault 5).
   - nginx sends to `172.27.0.6` while `getent hosts api` inside nginx returns `.5` (fault 6).
   - `docker compose stop api` takes 10.6 s and exits 137 (fault 7).
4. **The same runs after each fix**, recorded in
   [evidence/07-after-fixes.txt](evidence/07-after-fixes.txt).

## Monitoring and alerts

| Signal | Alert when | Catches |
| --- | --- | --- |
| Synthetic `GET /api/users` through nginx every 30 s | 2 failures in a row, or success under 99% over 10 min | 1, 2, 5, 6 |
| nginx 5xx ratio by upstream status, upstream response time p99 (access log with `$upstream_addr`, `$upstream_status`, `$upstream_response_time`) | 5xx over 1% for 5 min, or p99 over 500 ms | 1, 4, 5, 6 |
| Container restarts, exit codes, OOM kills, health status | any restart in 10 min; exit 137 on a planned stop; unhealthy for 1 min | 2, 3, 7 |
| `pg` pool total, idle and waiting clients; pool connect timeouts | waiting over 0 for 1 min; any connect timeout | 5 |
| Postgres connections by state and application, share of `max_connections` | over 80%, or the API holding its full pool while idle | 5 |
| Redis availability; failed `last_call` writes | Redis down 1 min; failed writes for 5 min | 4 |
| Error logs: unhandled `error` events, uncaught exceptions, process exits | any | 2, 3 |

## Preventing this in production

- **More than one API replica, behind health-checked routing.** With a single replica, every
  restart still costs about a second of 502s (the redeploy row above). With two or more,
  set proxy timeouts and retry idempotent requests on another replica (`proxy_next_upstream`).
- **An orchestrator with liveness and readiness probes** (ECS, Kubernetes). Compose only
  orders startup; it does not restart an unhealthy container.
- **Service discovery, not addresses resolved once.** The port and host the proxy uses should
  come from the same source as the app's listen port; CI runs `nginx -t` and a smoke test
  through the proxy.
- **Failure tests in CI.** `scripts/chaos.sh` against the compose stack, with a pass
  threshold per disruption, turns each fault above into a regression test.
- **Code rules that make these faults hard to write:** `pool.query` or `release()` in
  `finally`; a listener on every client's `error` event; a timeout on every dependency call;
  lint for floating promises; SIGTERM handling in the service template.
- **Supply chain and secrets:** lockfiles, base images pinned by digest and updated by
  Renovate or Dependabot, non-root containers, and credentials from a secret manager instead
  of `.env`.

## Running it

```bash
docker compose up -d --build --wait     # returns once every service is healthy
curl localhost:8080/api/users
scripts/chaos.sh restart-postgres       # needs k6 and Node; see the script for actions
```
