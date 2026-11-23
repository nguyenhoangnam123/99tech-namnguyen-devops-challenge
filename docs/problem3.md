# Problem 3: Debugging issues within system

[README](../README.md) · Answer: [SOLUTION.md](../src/problem3/SOLUTION.md) · Previous: [Problem 2](problem2.md) · Next: [Problem 4](problem4.md)

A Docker Compose stack (NGINX, an API, Postgres and Redis) whose API was unreliable and
sometimes unreachable. The original task is in [src/problem3/README.md](../src/problem3/README.md), titled "Problem 4".

## What the brief asks, and where it is answered

| The brief asks for       | Answer                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| What problems you found  | Eight faults, each with its effect and an evidence file ([root causes](../src/problem3/SOLUTION.md#root-causes))                             |
| How you diagnosed them   | [How the faults were found](../src/problem3/SOLUTION.md#how-the-faults-were-found)                                                           |
| The fixes you applied    | One fix per fault, with before and after results, most of them under load ([before and after](../src/problem3/SOLUTION.md#before-and-after)) |
| Monitoring and alerts    | [Monitoring and alerts](../src/problem3/SOLUTION.md#monitoring-and-alerts)                                                                   |
| Prevention in production | [Preventing this in production](../src/problem3/SOLUTION.md#preventing-this-in-production)                                                   |

## Documents

| Document                                                 | What it covers                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| [SOLUTION.md](../src/problem3/SOLUTION.md)               | The report: before and after, root causes, diagnosis, alerts, prevention |
| [README.md](../src/problem3/README.md)                   | The original task                                                        |
| [evidence/](../src/problem3/evidence)                    | The output that shows each fault, and a run after the fixes              |
| [scripts/chaos.sh](../src/problem3/scripts/chaos.sh)     | Loads the API at a steady rate and disrupts one dependency mid-run       |
| [docker-compose.yml](../src/problem3/docker-compose.yml) | The fixed stack                                                          |

## Check it yourself

Requires Docker; the chaos script also needs k6 and Node.

```bash
cd src/problem3
docker compose up -d --build --wait     # returns once every service is healthy
curl localhost:8080/api/users
scripts/chaos.sh restart-postgres       # see the script for the other actions
```
