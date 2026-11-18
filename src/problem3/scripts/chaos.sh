#!/usr/bin/env bash
# Load /api/users at a steady rate and disrupt one dependency mid-run.
# Usage: scripts/chaos.sh <none|restart-postgres|cancel-queries|stop-redis|recreate-api>
set -euo pipefail
cd "$(dirname "$0")/.."
action=${1:?usage: scripts/chaos.sh <none|restart-postgres|cancel-queries|stop-redis|recreate-api>}
at=${AT:-15}
out=$(mktemp -d)
cancel_for_10s="DO \$\$ DECLARE t timestamptz := clock_timestamp(); BEGIN
  WHILE clock_timestamp() < t + interval '10 seconds' LOOP
    PERFORM pg_stat_clear_snapshot();
    PERFORM pg_cancel_backend(pid) FROM pg_stat_activity
      WHERE backend_type = 'client backend' AND state = 'active' AND pid <> pg_backend_pid();
  END LOOP; END \$\$;"

k6 run -q --out "json=$out/points.json" -e "RATE=${RATE:-50}" -e "DURATION=${DURATION:-60s}" \
  scripts/load.js > "$out/k6.txt" 2>&1 &
load=$!
sleep "$at"
echo "t=${at}s: $action"
case $action in
  none) ;;
  restart-postgres) docker compose restart postgres ;;
  # A query that fails but keeps its connection, like a DBA cancel or a timeout.
  cancel-queries) docker compose exec -T postgres psql -U postgres -qAt -c "$cancel_for_10s" ;;
  stop-redis) docker compose stop redis && sleep 15 && docker compose start redis ;;
  recreate-api) docker compose up -d --force-recreate --no-deps api ;;
  *) echo "unknown action: $action" >&2; exit 2 ;;
esac 2>&1 | grep -v 'level=warning' || true
wait "$load" || true

seconds=${DURATION:-60s}; seconds=${seconds%s}
dropped=$(awk '/dropped_iterations/ {print $2}' "$out/k6.txt")
node scripts/timeline.mjs "$out/points.json" "${BUCKET:-5}" "$(( ${RATE:-50} * seconds ))" "${dropped:-0}"
docker compose ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null
rm -rf "$out"
