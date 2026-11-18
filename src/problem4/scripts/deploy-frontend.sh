#!/usr/bin/env bash
# Publishes one stored frontend build. Hashed assets go first and are
# never deleted, so pages already open keep loading; index.html is last.
source "$(dirname "$0")/lib.sh"
environment=${1:?usage: deploy-frontend.sh <environment> <commit-sha>}
version=${2:?usage: deploy-frontend.sh <environment> <commit-sha>}
require_environment "$environment"
require_version "$version"

config=$(aws ssm get-parameter --name "/p4/$environment/deploy" --query Parameter.Value --output text)
field() { jq -er ".$1" <<<"$config"; }
source="s3://$(field artifact_bucket)/frontend/$version"
site="s3://$(field site_bucket)"

aws s3 ls "$source/index.html" >/dev/null || fail "no frontend build $version in $source"
aws s3 sync "$source/assets/" "$site/assets/" --only-show-errors \
  --cache-control 'public, max-age=31536000, immutable'
aws s3 sync "$source/" "$site/" --only-show-errors --exclude 'assets/*' --exclude index.html \
  --cache-control 'public, max-age=300'
aws s3 cp "$source/index.html" "$site/index.html" --only-show-errors \
  --cache-control 'no-cache' --content-type 'text/html; charset=utf-8'

invalidation=$(aws cloudfront create-invalidation --distribution-id "$(field distribution_id)" \
  --paths '/' '/index.html' --query Invalidation.Id --output text)
aws cloudfront wait invalidation-completed --distribution-id "$(field distribution_id)" --id "$invalidation"
log "frontend $version is live in $environment"
echo "url=$(field url)" >>"${GITHUB_OUTPUT:-/dev/null}"
