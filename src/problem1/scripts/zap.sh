#!/usr/bin/env bash
# OWASP ZAP API scan of both OpenAPI contracts through the edge,
# authenticated as a fresh user. Reports land in reports/zap/.
set -euo pipefail
cd "$(dirname "$0")/.."

edge="http://127.0.0.1:${EDGE_PORT:-18080}"
email="zap-$(date +%s)@example.test"
password='correct horse battery staple'
credentials="{\"email\":\"$email\",\"password\":\"$password\"}"

curl -fsS -o /dev/null -H 'content-type: application/json' -d "$credentials" "$edge/v1/auth/register"
token=$(curl -fsS -H 'content-type: application/json' -d "$credentials" "$edge/v1/auth/login" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).accessToken))')

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
