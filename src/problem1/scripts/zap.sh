#!/usr/bin/env bash
# OWASP ZAP API scan of both OpenAPI contracts through the edge,
# authenticated as a fresh user. Reports land in reports/zap/.
set -euo pipefail
cd "$(dirname "$0")/.."

edge="http://127.0.0.1:${EDGE_PORT:-18080}"
email="zap-$(date +%s)@example.test"
password='correct horse battery staple'
credentials="{\"email\":\"$email\",\"password\":\"$password\"}"

response=$(mktemp)
trap 'rm -f "$response"' EXIT

# The per-IP auth limit may be spent by the abuse suite; wait out its window.
auth() {
  for _ in $(seq 1 20); do
    status=$(curl -sS -o "$response" -w '%{http_code}' -H 'content-type: application/json' \
      -d "$credentials" "$edge/v1/auth/$1")
    [ "$status" != 429 ] && return 0
    sleep 5
  done
  return 1
}
auth register
auth login
token=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).accessToken)' "$response")

mkdir -p reports/zap
chmod 777 reports/zap
replacer="-config replacer.full_list(0).description=auth \
-config replacer.full_list(0).enabled=true \
-config replacer.full_list(0).matchtype=REQ_HEADER \
-config replacer.full_list(0).matchstr=Authorization \
-config replacer.full_list(0).regex=false \
-config replacer.full_list(0).replacement=Bearer%20$token"

for api in oms marketdata; do
  docker run --rm --network exchange_default \
    -v "$PWD/contracts/openapi:/zap/specs:ro" -v "$PWD/reports/zap:/zap/wrk:rw" \
    zaproxy/zap-stable:2.17.0 zap-api-scan.py \
    -t "/zap/specs/$api.yaml" -f openapi -O http://edge:8080 \
    -r "$api.html" -J "$api.json" -I -z "${replacer//%20/ }" || true
done

node scripts/zap-summary.mjs reports/zap/oms.json reports/zap/marketdata.json
