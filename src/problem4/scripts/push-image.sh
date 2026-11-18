#!/usr/bin/env bash
# Pushes the image built for a commit to ECR. Tags are immutable, so a
# re-run of the same commit finds it there and stops.
source "$(dirname "$0")/lib.sh"
version=${1:?usage: push-image.sh <commit-sha>}
require_version "$version"

repository=$(param_field /p4/shared/build ecr_repository)
name=${repository#*/}
if aws ecr describe-images --repository-name "$name" --image-ids "imageTag=$version" >/dev/null 2>&1; then
  log "$name:$version is already in ECR"
  exit 0
fi
aws ecr get-login-password | docker login --username AWS --password-stdin "${repository%%/*}"
docker tag "p4-backend:$version" "$repository:$version"
docker push "$repository:$version"
log "pushed $repository:$version"
