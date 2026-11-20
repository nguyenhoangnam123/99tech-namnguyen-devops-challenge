-- Run once by the database owner (Aurora's master user) after the schema
-- exists. Services stop connecting as the owner; they get data access only,
-- so the ledger's append-only triggers cannot be dropped or disabled.
-- Later migrations run as exchange_owner (dbmate: options=-c role=...).

create role exchange_owner nologin;
create role exchange_app nologin;
create role oms_api login in role exchange_app;
create role oms_settler login in role exchange_app;
create role oms_relay login;

-- Aurora's master is not a superuser: it must be able to act as the owner
-- to hand objects over, and the owner needs CREATE for later migrations.
grant exchange_owner to current_user with set true, inherit true;
grant usage, create on schema public to exchange_owner;

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I owner to exchange_owner', r.tablename);
  end loop;
  -- Extension functions such as citext's stay with the extension.
  for r in select p.oid::regprocedure as fn from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and not exists (
             select from pg_depend d
             where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') loop
    execute format('alter function %s owner to exchange_owner', r.fn);
  end loop;
end $$;

revoke all on schema public from public;
grant usage on schema public to exchange_app, oms_relay;

grant select, insert, update, delete on all tables in schema public to exchange_app;
grant usage, select on all sequences in schema public to exchange_app;
-- Journal entries are written once and never changed, by anyone.
revoke update, delete on journal_entries from exchange_app;
-- The relay publishes and prunes the outbox, and touches nothing else.
grant select, update (published_at), delete on outbox to oms_relay;

do $$
begin
  if to_regclass('public.schema_migrations') is not null then
    revoke all on public.schema_migrations from exchange_app;
  end if;
  -- IAM sign-in and pgaudit exist only on Aurora and RDS.
  if exists (select from pg_roles where rolname = 'rds_iam') then
    grant rds_iam to oms_api, oms_relay, oms_settler;
  end if;
  if exists (select from pg_available_extensions where name = 'pgaudit') then
    create extension if not exists pgaudit;
  end if;
end $$;

alter default privileges for role exchange_owner in schema public
  grant select, insert, update, delete on tables to exchange_app;
alter default privileges for role exchange_owner in schema public
  grant usage, select on sequences to exchange_app;
