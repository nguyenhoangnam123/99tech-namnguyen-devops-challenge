#!/usr/bin/env bash
# Creates local-only secrets once; deploy/.env and deploy/.secrets are gitignored.
set -euo pipefail
cd "$(dirname "$0")/../deploy"
mkdir -p .secrets
chmod 700 .secrets
umask 077
[ -f .secrets/jwt-private-key.pem ] || node -e "
  const { generateKeyPairSync } = require('node:crypto');
  const { privateKey } = generateKeyPairSync('ed25519');
  process.stdout.write(privateKey.export({ type: 'pkcs8', format: 'pem' }));
" > .secrets/jwt-private-key.pem
[ -f .secrets/custody-webhook-secret ] || openssl rand -hex 32 > .secrets/custody-webhook-secret
[ -f .env ] || echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" > .env
# Containers run as nonroot and read the mounted files.
chmod 644 .secrets/*
echo "secrets ready in deploy/.secrets and deploy/.env"
