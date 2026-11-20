-- Run once by the migration owner after the schema exists.
-- Services stop connecting as the owner: they get data access only,
-- so the ledger's append-only triggers cannot be dropped or disabled.

create role exchange_owner nologin;
create role exchange_app nologin;
create role oms_api login in role exchange_app;
create role oms_relay login in role exchange_app;
create role oms_settler login in role exchange_app;

-- The owner, not a login role, holds every table and function.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I owner to exchange_owner', r.tablename);
  end loop;
  for r in select p.oid::regprocedure as fn from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' loop
    execute format('alter function %s owner to exchange_owner', r.fn);
  end loop;
end $$;

revoke all on schema public from public;
grant usage on schema public to exchange_app;
grant select, insert, update, delete on all tables in schema public to exchange_app;
grant usage, select on all sequences in schema public to exchange_app;

-- Journal entries are written once and never changed, by anyone.
revoke update, delete, truncate on journal_entries from exchange_app;

alter default privileges for role exchange_owner in schema public
  grant select, insert, update, delete on tables to exchange_app;
