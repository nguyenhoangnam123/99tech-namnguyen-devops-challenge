#!/usr/bin/env bash
# Rolls the backend to one image with no capacity drop; AWS rolls
# back by itself on failed health checks or a rollback alarm.
# shellcheck disable=SC2016 # '$Default' is AWS's version name, not a variable.
source "$(dirname "$0")/lib.sh"
environment=${1:?usage: deploy-backend.sh <environment> <commit-sha>}
version=${2:?usage: deploy-backend.sh <environment> <commit-sha>}
require_environment "$environment"
require_version "$version"

config=$(aws ssm get-parameter --name "/p4/$environment/deploy" --query Parameter.Value --output text)
field() { jq -er ".$1" <<<"$config"; }
group=$(field autoscaling_group)
template=$(field launch_template_id)

aws ecr describe-images --repository-name "$(field ecr_repository)" \
  --image-ids "imageTag=$version" >/dev/null || fail "no image $version in ECR"

# A new template version: the infra's default version with this image's tag.
tags=$(aws ec2 describe-launch-template-versions --launch-template-id "$template" \
  --versions '$Default' --query 'LaunchTemplateVersions[0].LaunchTemplateData.TagSpecifications' |
  jq -c --arg v "$version" 'map(if .ResourceType == "instance"
    then .Tags = ([.Tags[] | select(.Key != "ImageTag")] + [{Key: "ImageTag", Value: $v}]) else . end)')
new_version=$(aws ec2 create-launch-template-version --launch-template-id "$template" \
  --source-version '$Default' --version-description "backend $version" \
  --launch-template-data "{\"TagSpecifications\": $tags}" \
  --query LaunchTemplateVersion.VersionNumber --output text)
log "launch template $template version $new_version runs $version"

alarms=$(field rollback_alarms | jq -c .)
# Healthy-capacity bounds come from the group's maintenance policy.
refresh=$(aws autoscaling start-instance-refresh --auto-scaling-group-name "$group" \
  --desired-configuration "{\"LaunchTemplate\": {\"LaunchTemplateId\": \"$template\", \"Version\": \"$new_version\"}}" \
  --preferences "{\"InstanceWarmup\": 60, \"SkipMatching\": false, \"AutoRollback\": true,
    \"AlarmSpecification\": {\"Alarms\": $alarms}}" \
  --query InstanceRefreshId --output text)
log "instance refresh $refresh started on $group"
started=$(date -u +%Y-%m-%dT%H:%M:%S)

# Auto Scaling retries abandoned launches forever, so two of them,
# or the deadline, mean the image is bad: roll back and fail.
abandoned_launches() {
  aws autoscaling describe-scaling-activities --auto-scaling-group-name "$group" --max-items 20 |
    jq --arg t "$started" '[.Activities[] | select(.StartTime >= $t and .StatusCode == "Cancelled")] | length'
}

deadline=$((SECONDS + 1200))
rolling_back=false
while true; do
  read -r status percent < <(aws autoscaling describe-instance-refreshes \
    --auto-scaling-group-name "$group" --instance-refresh-ids "$refresh" \
    --query 'InstanceRefreshes[0].[Status, PercentageComplete]' --output text)
  log "refresh $status, ${percent}% complete"
  case $status in
    Successful) break ;;
    Failed | Cancelled | RollbackSuccessful | RollbackFailed)
      fail "refresh ended $status; $group keeps the previous image" ;;
  esac
  if ! $rolling_back && { (($(abandoned_launches) >= 2)) || ((SECONDS > deadline)); }; then
    log "new instances never became healthy; rolling back"
    aws autoscaling rollback-instance-refresh --auto-scaling-group-name "$group" >/dev/null
    rolling_back=true
  fi
  sleep 15
done

aws ssm put-parameter --name "$(field image_tag_parameter)" --value "$version" --overwrite >/dev/null
log "backend $version is live in $environment"
echo "url=$(field url)" >>"${GITHUB_OUTPUT:-/dev/null}"
