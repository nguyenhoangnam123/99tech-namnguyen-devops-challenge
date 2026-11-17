-- migrate:up
create extension if not exists citext;

create table users (
  id uuid primary key,
  email citext not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- Exchange-owned accounts have no owner: EXTERNAL mirrors custody, FEES collects fees.
create table accounts (
  id bigint generated always as identity primary key,
  owner_id uuid references users (id),
  asset text not null,
  kind text not null check (kind in ('AVAILABLE', 'HELD', 'EXTERNAL', 'FEES')),
  balance numeric(36, 18) not null default 0,
  constraint accounts_owner_asset_kind unique nulls not distinct (owner_id, asset, kind),
  constraint accounts_owner_matches_kind check ((owner_id is null) = (kind in ('EXTERNAL', 'FEES'))),
  constraint accounts_user_non_negative check (owner_id is null or balance >= 0)
);

insert into accounts (owner_id, asset, kind)
select null, asset, kind
from unnest(array['BTC', 'ETH', 'USDT']) as asset,
     unnest(array['EXTERNAL', 'FEES']) as kind;

create table journal_entries (
  id bigint generated always as identity primary key,
  journal_id uuid not null,
  account_id bigint not null references accounts (id),
  amount numeric(36, 18) not null check (amount <> 0),
  reason text not null check (reason in ('DEPOSIT', 'ORDER_HOLD', 'ORDER_RELEASE', 'TRADE')),
  ref_id text not null,
  created_at timestamptz not null default now()
);

create index journal_entries_account on journal_entries (account_id, id);
create index journal_entries_journal on journal_entries (journal_id);

create function reject_journal_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'journal_entries is append-only';
end $$;

create trigger journal_entries_append_only
  before update or delete on journal_entries
  for each statement execute function reject_journal_mutation();

-- Checked at commit: every journal nets to zero per asset.
create function assert_journal_balanced() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1
    from journal_entries e
    join accounts a on a.id = e.account_id
    where e.journal_id = new.journal_id
    group by a.asset
    having sum(e.amount) <> 0
  ) then
    raise exception 'journal % is not balanced', new.journal_id using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger journal_entries_balanced
  after insert on journal_entries
  deferrable initially deferred
  for each row execute function assert_journal_balanced();

create table orders (
  id uuid primary key,
  user_id uuid not null references users (id),
  client_order_id text not null,
  symbol text not null,
  side text not null check (side in ('BUY', 'SELL')),
  type text not null check (type in ('LIMIT', 'MARKET')),
  time_in_force text not null check (time_in_force in ('GTC', 'IOC')),
  price numeric(36, 18),
  quantity numeric(36, 18),
  quote_quantity numeric(36, 18),
  reserved_asset text not null,
  reserved numeric(36, 18) not null check (reserved > 0),
  reserved_remaining numeric(36, 18) not null check (reserved_remaining >= 0),
  filled_quantity numeric(36, 18) not null default 0,
  filled_quote numeric(36, 18) not null default 0,
  status text not null check (status in ('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED')),
  done_reason text,
  cancel_requested_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint orders_user_client_order_id unique (user_id, client_order_id)
);

create index orders_user_created on orders (user_id, created_at desc);
create index orders_user_open on orders (user_id, symbol) where status in ('NEW', 'PARTIALLY_FILLED');

-- One row per order side of a trade.
create table fills (
  trade_id text not null,
  order_id uuid not null references orders (id),
  user_id uuid not null references users (id),
  symbol text not null,
  side text not null check (side in ('BUY', 'SELL')),
  role text not null check (role in ('MAKER', 'TAKER')),
  price numeric(36, 18) not null,
  quantity numeric(36, 18) not null,
  fee numeric(36, 18) not null,
  fee_asset text not null,
  executed_at timestamptz not null,
  primary key (trade_id, order_id)
);

create index fills_user_executed on fills (user_id, executed_at desc);

create table deposit_addresses (
  address text primary key,
  user_id uuid not null references users (id),
  asset text not null,
  created_at timestamptz not null default now(),
  constraint deposit_addresses_user_asset unique (user_id, asset)
);

-- tx_id is the custody provider's id: the exactly-once key.
create table deposits (
  tx_id text primary key,
  address text not null,
  asset text not null,
  amount numeric(36, 18) not null check (amount > 0),
  user_id uuid references users (id),
  status text not null check (status in ('CREDITED', 'UNMATCHED')),
  received_at timestamptz not null
);

create table outbox (
  id bigint generated always as identity primary key,
  topic text not null,
  message_key text not null,
  payload bytea not null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create index outbox_unpublished on outbox (id) where published_at is null;

create table inbox (
  consumer text not null,
  event_id text not null,
  processed_at timestamptz not null default now(),
  primary key (consumer, event_id)
);

-- migrate:down
drop table inbox;
drop table outbox;
drop table deposits;
drop table deposit_addresses;
drop table fills;
drop table orders;
drop table journal_entries;
drop function assert_journal_balanced;
drop function reject_journal_mutation;
drop table accounts;
drop table users;
