import type { DB } from '@exchange/contracts';
import { ASSETS, type Fill, parseAmount } from '@exchange/core';
import type { Kysely } from '@exchange/platform';
import type {
  BalanceView,
  Credentials,
  OrderFilter,
  OrderRecord,
  ReadModel,
} from '../../app/ports.js';
import { toFill, toOrderRecord } from './rows.js';

const OPEN_STATUSES = ['NEW', 'PARTIALLY_FILLED'];

export class PgReadModel implements ReadModel {
  constructor(private readonly db: Kysely<DB>) {}

  async credentials(email: string): Promise<Credentials | undefined> {
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirst();
    return row && { userId: row.id, passwordHash: row.password_hash };
  }

  async balances(userId: string): Promise<BalanceView[]> {
    const rows = await this.db
      .selectFrom('accounts')
      .select(['asset', 'kind', 'balance'])
      .where('owner_id', '=', userId)
      .execute();
    const amountOf = (asset: string, kind: string): bigint =>
      parseAmount(rows.find((row) => row.asset === asset && row.kind === kind)?.balance ?? '0');
    return ASSETS.map((asset) => ({
      asset,
      available: amountOf(asset, 'AVAILABLE'),
      held: amountOf(asset, 'HELD'),
    }));
  }

  async order(userId: string, orderId: string): Promise<OrderRecord | undefined> {
    const row = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row && toOrderRecord(row);
  }

  async orders(userId: string, filter: OrderFilter): Promise<OrderRecord[]> {
    let query = this.db.selectFrom('orders').selectAll().where('user_id', '=', userId);
    if (filter.symbol) query = query.where('symbol', '=', filter.symbol);
    if (filter.openOnly) query = query.where('status', 'in', OPEN_STATUSES);
    const rows = await query.orderBy('created_at', 'desc').limit(filter.limit).execute();
    return rows.map(toOrderRecord);
  }

  async fills(
    userId: string,
    filter: { symbol?: string | undefined; limit: number },
  ): Promise<Fill[]> {
    let query = this.db.selectFrom('fills').selectAll().where('user_id', '=', userId);
    if (filter.symbol) query = query.where('symbol', '=', filter.symbol);
    const rows = await query.orderBy('executed_at', 'desc').limit(filter.limit).execute();
    return rows.map(toFill);
  }
}
