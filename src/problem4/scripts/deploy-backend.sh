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
refresh=$(aws autoscaling start-instance-refresh --auto-scaling-group-name "$group" \
  --desired-configuration "{\"LaunchTemplate\": {\"LaunchTemplateId\": \"$template\", \"Version\": \"$new_version\"}}" \
  --preferences "{\"MinHealthyPercentage\": 100, \"MaxHealthyPercentage\": 200, \"InstanceWarmup\": 60,
    \"SkipMatching\": false, \"AutoRollback\": true,
    \"AlarmSpecification\": {\"Alarms\": $alarms}}" \
  --query InstanceRefreshId --output text)
log "instance refresh $refresh started on $group"

deadline=$((SECONDS + 1500))
while ((SECONDS < deadline)); do
  read -r status percent < <(aws autoscaling describe-instance-refreshes \
    --auto-scaling-group-name "$group" --instance-refresh-ids "$refresh" \
    --query 'InstanceRefreshes[0].[Status, PercentageComplete]' --output text)
  log "refresh $status, ${percent}% complete"
  case $status in
    Successful) break ;;
    Failed | Cancelled | RollbackSuccessful | RollbackFailed)
      fail "refresh ended $status; $group keeps the previous image" ;;
  esac
  sleep 15
done
[[ $status == Successful ]] || fail "refresh did not finish in 25 minutes"

aws ssm put-parameter --name "$(field image_tag_parameter)" --value "$version" --overwrite >/dev/null
log "backend $version is live in $environment"
echo "url=$(field url)" >>"${GITHUB_OUTPUT:-/dev/null}"
