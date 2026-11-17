-- migrate:up
-- Ledger posts look accounts up by owner, where NULL means the exchange.
-- IS NOT DISTINCT FROM cannot use an index, so join on this expression.
create unique index accounts_lookup
  on accounts ((coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)), asset, kind);

-- migrate:down
drop index accounts_lookup;
