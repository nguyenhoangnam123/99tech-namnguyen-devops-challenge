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

# Join the load balancer only once the API answers here; otherwise
# abandon, so Auto Scaling replaces the instance and the refresh fails.
result=ABANDON
for _ in $(seq 1 30); do
  if curl -sf --max-time 2 http://127.0.0.1/healthz >/dev/null; then result=CONTINUE; break; fi
  sleep 2
done
aws autoscaling complete-lifecycle-action --region ${region} --instance-id "$instance" \
  --auto-scaling-group-name ${group} --lifecycle-hook-name ${hook} --lifecycle-action-result "$result"
