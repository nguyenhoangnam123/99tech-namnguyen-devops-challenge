#!/usr/bin/env bash
# Checks through CloudFront, as a user would, that the environment
# serves this exact version. Retries cover edge propagation.
source "$(dirname "$0")/lib.sh"
app=${1:?usage: smoke.sh <backend|frontend> <environment> <commit-sha>}
environment=${2:?usage: smoke.sh <backend|frontend> <environment> <commit-sha>}
version=${3:?usage: smoke.sh <backend|frontend> <environment> <commit-sha>}
require_environment "$environment"
require_version "$version"
url=$(param_field "/p4/$environment/deploy" url)

served() {
  case $app in
    backend) curl -sf --max-time 5 "$url/api/version" | jq -r .version ;;
    frontend) curl -sf --max-time 5 "$url/" | sed -n 's/.*name="app-version" content="\([0-9a-f]*\)".*/\1/p' ;;
    *) fail "app must be backend or frontend" ;;
  esac
}

for attempt in $(seq 1 20); do
  got=$(served || true)
  if [[ $got == "$version" ]]; then
    log "$app serves $version at $url"
    exit 0
  fi
  log "attempt $attempt: $app serves '${got:-nothing}', want $version"
  sleep 6
done
fail "$app at $url never served $version"
