#!/bin/bash
# Boots one backend instance: Docker, then the image named by this
# instance's ImageTag tag, which each deploy sets on the launch template.
set -euo pipefail

dnf install -y docker
systemctl enable --now docker

imds() {
  local token
  token=$(curl -sf -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
  curl -sf -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"
}
tag=$(imds tags/instance/ImageTag)
instance=$(imds instance-id)

aws ecr get-login-password --region ${region} |
  docker login --username AWS --password-stdin ${registry}
docker run -d --name backend --restart unless-stopped -p 80:8080 \
  -e APP_VERSION="$tag" -e APP_ENV=${environment} \
  --log-driver awslogs --log-opt awslogs-region=${region} \
  --log-opt awslogs-group=${log_group} --log-opt awslogs-stream="$instance" \
  "${repository}:$tag"
