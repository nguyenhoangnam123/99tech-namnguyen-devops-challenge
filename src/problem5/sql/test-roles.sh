#!/usr/bin/env bash
# Builds Problem 1's schema the way Aurora would: a non-superuser master owns
# the database, runs the migrations and roles.sql. Then each role tries the
# same ledger attacks; a refusal counts only with SQLSTATE 42501.
set -euo pipefail
cd "$(dirname "$0")"
MIGRATIONS=../../problem1/contracts/db/migrations
NAME=p5-roles-test

docker run -d --rm --name "$NAME" -e POSTGRES_USER=exchange -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=exchange postgres:17.12-alpine >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
# Init runs a socket-only server first; TCP answers once the real one is up.
until docker exec "$NAME" pg_isready -h 127.0.0.1 -U exchange -q; do sleep 1; done

psql() { docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U "$1" -d ledger; }
# exchange is wave 1's role: the image's superuser. exchange_admin plays
# Aurora's master: CREATEROLE, database owner, may grant rds_iam.
docker exec -i "$NAME" psql -q -U exchange -d exchange <<'SQL'
create role exchange_admin login createrole;
create role rds_iam nologin;
grant rds_iam to exchange_admin with admin option;
create database ledger owner exchange_admin;
SQL
for file in "$MIGRATIONS"/*.sql; do
  sed -n '/-- migrate:up/,/-- migrate:down/p' "$file" | psql exchange_admin
done
psql exchange_admin < roles.sql
# A later migration, run as the owner, must reach the services unaided.
psql exchange_admin <<'SQL'
set role exchange_owner;
create table later_migration (id bigint generated always as identity primary key);
SQL

attacks=(
  "update journal_entries set amount = amount where false"
  "delete from journal_entries where false"
  "truncate journal_entries"
  "alter table journal_entries disable trigger journal_entries_append_only"
  "alter table journal_entries disable trigger journal_entries_append_only; update journal_entries set amount = amount * 2"
  "set session_replication_role = replica; delete from journal_entries"
  "drop table journal_entries"
  "create table public.backdoor (id int)"
  "grant exchange_owner to current_user"
)
# What the app does; the relay only touches the outbox.
needed_by_app=(
  "select count(*) from journal_entries"
  "insert into journal_entries (journal_id, account_id, amount, reason, ref_id) select journal_id, account_id, amount, reason, ref_id from journal_entries where false"
  "select id from accounts where false for update"
  "insert into outbox (topic, message_key, payload) select topic, message_key, payload from outbox where false"
  "insert into later_migration default values"
)
needed_by_relay=(
  "select id from outbox where published_at is null limit 1"
  "update outbox set published_at = now() where false"
  "delete from outbox where false"
  "select pg_try_advisory_lock(42)"
)
denied_to_relay=(
  "select password_hash from users limit 1"
  "update accounts set balance = balance where false"
)
# Open: balances are updated by the app, so a service could change one
# without a journal entry. Section 5.4 of the report covers it.
known_open=(
  "update accounts set balance = balance + 1000 where false"
)

# Prints allowed, denied (SQLSTATE 42501), or the SQLSTATE of another error.
run() {
  local out
  if out=$(printf '\\set VERBOSITY verbose\nbegin;\n%s;\nrollback;\n' "$2" | psql "$1" 2>&1); then
    echo allowed
  elif [[ $out =~ ERROR:\ +([0-9A-Z]{5}) ]]; then
    [[ ${BASH_REMATCH[1]} == 42501 ]] && echo denied || echo "error-${BASH_REMATCH[1]}"
  else
    echo "error"
  fi
}

roles=(exchange oms_api oms_settler oms_relay)
failures=0
# row "<want for oms_api> <oms_settler> <oms_relay>" statement; - means any.
row() {
  local -a want cells
  read -ra want <<<"$1"
  cells=("$(run exchange "$2")")
  for i in 0 1 2; do
    cells+=("$(run "${roles[i + 1]}" "$2")")
    [[ ${want[i]} == - || ${cells[i + 1]} == "${want[i]}" ]] || failures=$((failures + 1))
  done
  printf '%-12s %-12s %-12s %-12s %s\n' "${cells[@]}" "$2"
}

printf '%-12s %-12s %-12s %-12s %s\n' "${roles[@]}" statement
for sql in "${attacks[@]}"; do row "denied denied denied" "$sql"; done
for sql in "${needed_by_app[@]}"; do row "allowed allowed -" "$sql"; done
for sql in "${needed_by_relay[@]}"; do row "- - allowed" "$sql"; done
for sql in "${denied_to_relay[@]}"; do row "- - denied" "$sql"; done
for sql in "${known_open[@]}"; do row "- - -" "$sql"; done

member=$(docker exec "$NAME" psql -tAq -U exchange -d ledger -c "select string_agg(rolname, ',' order by rolname) from pg_roles where pg_has_role(rolname, 'rds_iam', 'member') and rolname like 'oms_%'")
echo "rds_iam members: $member"
[[ $member == oms_api,oms_relay,oms_settler ]] || failures=$((failures + 1))
echo "unexpected results: $failures"
exit "$failures"
