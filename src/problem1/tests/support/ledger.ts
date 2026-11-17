import pg from 'pg';
import { env } from './env.js';

// Each query returns rows only when an invariant is broken.
// They hold at every commit, so they are safe to run while trading.
const INVARIANTS: Record<string, string> = {
  'every asset nets to zero across all accounts': `
    select asset, sum(balance) as total from accounts group by asset having sum(balance) <> 0`,
  'every balance equals the sum of its journal entries': `
    select a.id, a.balance, coalesce(j.total, 0) as journal
    from accounts a
    left join (select account_id, sum(amount) as total from journal_entries group by account_id) j
      on j.account_id = a.id
    where a.balance <> coalesce(j.total, 0)`,
  'held funds equal what open orders still reserve': `
    select a.owner_id, a.asset, a.balance, coalesce(o.reserved, 0) as reserved
    from accounts a
    left join (
      select user_id, reserved_asset, sum(reserved_remaining) as reserved from orders group by 1, 2
    ) o on o.user_id = a.owner_id and o.reserved_asset = a.asset
    where a.kind = 'HELD' and a.balance <> coalesce(o.reserved, 0)`,
  'fee accounts equal the fees on fills': `
    select a.asset, a.balance, coalesce(f.fees, 0) as fees
    from accounts a
    left join (select fee_asset, sum(fee) as fees from fills group by fee_asset) f on f.fee_asset = a.asset
    where a.kind = 'FEES' and a.balance <> coalesce(f.fees, 0)`,
  'custody mirror equals credited deposits': `
    select a.asset, a.balance, coalesce(d.credited, 0) as credited
    from accounts a
    left join (
      select asset, sum(amount) as credited from deposits where status = 'CREDITED' group by asset
    ) d on d.asset = a.asset
    where a.kind = 'EXTERNAL' and -a.balance <> coalesce(d.credited, 0)`,
  'closed orders hold nothing': `
    select id, status, reserved_remaining from orders
    where status in ('FILLED', 'CANCELLED', 'EXPIRED') and reserved_remaining <> 0`,
  'no order fills beyond its size': `
    select id from orders where quantity is not null and filled_quantity > quantity`,
  'every trade has exactly two fills': `
    select trade_id, count(*) from fills group by trade_id having count(*) <> 2`,
};

export async function ledgerViolations(): Promise<Record<string, unknown[]>> {
  const client = new pg.Client({ connectionString: env.databaseUrl });
  await client.connect();
  try {
    const violations: Record<string, unknown[]> = {};
    for (const [name, query] of Object.entries(INVARIANTS)) {
      const { rows } = await client.query(query);
      if (rows.length > 0) violations[name] = rows;
    }
    return violations;
  } finally {
    await client.end();
  }
}

export async function scalar<T>(query: string, params: unknown[] = []): Promise<T> {
  const client = new pg.Client({ connectionString: env.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ value: T }>(query, params);
    return rows[0]?.value as T;
  } finally {
    await client.end();
  }
}
