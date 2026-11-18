#!/usr/bin/env bash
# Creates the two GitHub environments and the variables workflows read.
# Production waits for a reviewer and takes deploys from main only.
source "$(dirname "$0")/lib.sh"
region=${1:?usage: github-setup.sh <region>}
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
owner_id=$(gh api user --jq .id)
role_arn() { aws iam get-role --role-name "$1" --query Role.Arn --output text; }

gh variable set AWS_REGION --repo "$repo" --body "$region"
gh variable set AWS_BUILD_ROLE_ARN --repo "$repo" --body "$(role_arn p4-github-build)"

for environment in staging production; do
  reviewers='[]'
  [[ $environment == production ]] && reviewers="[{\"type\": \"User\", \"id\": $owner_id}]"
  gh api -X PUT "repos/$repo/environments/$environment" --input - >/dev/null <<JSON
{"reviewers": $reviewers, "prevent_self_review": false,
 "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
  gh api "repos/$repo/environments/$environment/deployment-branch-policies" --jq '.branch_policies[].name' |
    grep -qx main ||
    gh api -X POST "repos/$repo/environments/$environment/deployment-branch-policies" \
      -f name=main -f type=branch >/dev/null
  gh variable set AWS_DEPLOY_ROLE_ARN --repo "$repo" --env "$environment" \
    --body "$(role_arn "p4-github-deploy-$environment")"
  log "$environment: main only, reviewers $reviewers"
done
