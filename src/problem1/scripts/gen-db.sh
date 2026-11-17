#!/usr/bin/env bash
# Applies the migrations to a throwaway Postgres and emits Kysely types.
set -euo pipefail
cd "$(dirname "$0")/.."
name="exchange-gen-db-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$name" -e POSTGRES_PASSWORD=gen -p 127.0.0.1::5432 postgres:17.12-alpine >/dev/null
port=$(docker port "$name" 5432/tcp | head -1 | cut -d: -f2)
until docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; do sleep 0.5; done
sleep 1

url="postgres://postgres:gen@127.0.0.1:${port}/postgres?sslmode=disable"
docker run --rm --network "container:$name" -v "$PWD/contracts/db:/db" amacneil/dbmate:2.38.1 \
  --url "postgres://postgres:gen@localhost:5432/postgres?sslmode=disable" \
  --migrations-dir /db/migrations --no-dump-schema up
npx kysely-codegen --dialect postgres --url "$url" \
  --exclude-pattern schema_migrations --out-file packages/contracts/src/gen/db.ts
