#!/usr/bin/env bash
# Stores a frontend build under its commit. Every environment deploys
# these same files, so what staging tested is what production gets.
source "$(dirname "$0")/lib.sh"
version=${1:?usage: upload-frontend.sh <commit-sha> <dist-dir>}
dist=${2:?usage: upload-frontend.sh <commit-sha> <dist-dir>}
require_version "$version"
grep -q "content=\"$version\"" "$dist/index.html" || fail "$dist was not built for $version"

bucket=$(param_field /p4/shared/build artifact_bucket)
aws s3 sync "$dist" "s3://$bucket/frontend/$version/" --only-show-errors
log "uploaded s3://$bucket/frontend/$version/"
