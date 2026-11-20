#!/usr/bin/env bash
# Applies Problem 1's migrations to a throwaway Postgres, then tries the
# same ledger attacks as wave 1's role and as a restricted service role.
set -euo pipefail
cd "$(dirname "$0")"
MIGRATIONS=../../problem1/contracts/db/migrations
NAME=p5-roles-test

docker run -d --rm --name "$NAME" -e POSTGRES_USER=exchange -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=exchange postgres:17.12-alpine >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
until docker exec "$NAME" pg_isready -U exchange -q; do sleep 1; done

psql() { docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U "$1" -d exchange; }
for file in "$MIGRATIONS"/*.sql; do
  sed -n '/-- migrate:up/,/-- migrate:down/p' "$file" | psql exchange
done
psql exchange < roles.sql

# Each attack runs in a transaction that is rolled back either way.
attacks=(
  "update journal_entries set amount = amount where false"
  "delete from journal_entries where false"
  "truncate journal_entries"
  "alter table journal_entries disable trigger journal_entries_append_only"
  "set session_replication_role = replica"
  "alter table journal_entries disable trigger journal_entries_append_only; update journal_entries set amount = amount * 2"
  "set session_replication_role = replica; delete from journal_entries"
  "drop table journal_entries"
  "create table public.backdoor (id int)"
)
needed=(
  "select count(*) from journal_entries"
  "update accounts set balance = balance where false"
  "insert into outbox (topic, message_key, payload) select topic, message_key, payload from outbox where false"
  "insert into journal_entries (journal_id, account_id, amount, reason, ref_id) select journal_id, account_id, amount, reason, ref_id from journal_entries where false"
)

failures=0
run() { # role, statement -> prints allowed or denied
  if printf 'begin;\n%s;\nrollback;\n' "$2" | psql "$1" >/dev/null 2>&1; then echo allowed; else echo denied; fi
}
printf '%-110s %-9s %s\n' statement exchange oms_settler
for sql in "${attacks[@]}"; do
  before=$(run exchange "$sql"); after=$(run oms_settler "$sql")
  printf '%-110s %-9s %s\n' "$sql" "$before" "$after"
  [ "$after" = denied ] || failures=$((failures + 1))
done
for sql in "${needed[@]}"; do
  after=$(run oms_settler "$sql")
  printf '%-110s %-9s %s\n' "$sql" "-" "$after"
  [ "$after" = allowed ] || failures=$((failures + 1))
done
echo "unexpected results: $failures"
exit "$failures"
