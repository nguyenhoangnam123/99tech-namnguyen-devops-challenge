#!/usr/bin/env bash
# Shared helpers. Deploy settings come from SSM parameters that
# Terraform writes, so workflows only need a role ARN and a region.
set -euo pipefail

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
fail() { log "error: $*"; exit 1; }

require_version() {
  [[ $1 =~ ^[0-9a-f]{40}$ ]] || fail "version must be a full commit SHA, got '$1'"
}

require_environment() {
  [[ $1 == staging || $1 == production ]] || fail "environment must be staging or production"
}

# Prints one field of a JSON SSM parameter.
param_field() {
  aws ssm get-parameter --name "$1" --query Parameter.Value --output text | jq -er ".$2"
}
