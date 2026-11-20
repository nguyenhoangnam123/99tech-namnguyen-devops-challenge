#!/usr/bin/env bash
# A: the edge as it was. B: max_fails=0, so slow replies never eject a replica.
# Slow POSTs time out, then plain GETs show whether any replica is left.
set -euo pipefail
cd "$(dirname "$0")"
cleanup() { docker rm -f edge-ab-app1 edge-ab-app2 edge-ab-A edge-ab-B >/dev/null 2>&1 || true; docker network rm edge-ab >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker network create edge-ab >/dev/null
for i in 1 2; do docker run -d --name edge-ab-app$i --network edge-ab --network-alias app -v "$PWD/app.py:/app.py:ro" python:3.13-slim python -u /app.py >/dev/null; done
port=18181
for v in A B; do
  docker run -d --name edge-ab-$v --network edge-ab -p 127.0.0.1:$port:8080 -v "$PWD/$v.conf:/etc/nginx/nginx.conf:ro" nginx:1.28.1-alpine >/dev/null
  until curl -s -o /dev/null "http://127.0.0.1:$port/"; do sleep 0.5; done
  before=$(for _ in 1 2 3 4; do curl -s -o /dev/null -w '%{http_code} ' "http://127.0.0.1:$port/"; done)
  for _ in 1 2 3 4 5 6; do curl -s -o /dev/null -X POST -d x "http://127.0.0.1:$port/login" & done; wait
  after=$(for _ in 1 2 3 4; do curl -s -o /dev/null -w '%{http_code} ' "http://127.0.0.1:$port/"; done)
  echo "$v: GETs before slow POSTs: $before| GETs right after: $after"
  sleep 11 # let the 10 s fail_timeout lapse, so both sides start with two live replicas
  docker stop -t 0 edge-ab-app2 >/dev/null
  dead=$(for _ in 1 2 3 4 5 6; do curl -s -o /dev/null -w '%{http_code} ' "http://127.0.0.1:$port/"; done)
  echo "$v: GETs with one replica stopped: $dead"
  docker start edge-ab-app2 >/dev/null; sleep 6
  port=$((port + 1))
done
