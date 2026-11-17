import { encodeCommand } from '@exchange/codecs';
import { type DB, TOPICS } from '@exchange/contracts';
import {
  type Asset,
  type DoneReason,
  type Fill,
  InvariantViolation,
  type MatcherCommand,
  type OrderFunds,
  formatAmount,
} from '@exchange/core';
import { type Transaction, activeTraceCarrier } from '@exchange/platform';
import type {
  CommandOutbox,
  DepositRecord,
  DepositStore,
  FillStore,
  Inbox,
  Inserted,
  NewOrder,
  OrderRecord,
  OrderStore,
  UserStore,
} from '../../app/ports.js';
import { asAsset, toDepositRecord, toFillInsert, toOrderInsert, toOrderRecord } from './rows.js';

export class PgUserStore implements UserStore {
  constructor(private readonly trx: Transaction<DB>) {}

  async create(user: {
    id: string;
    email: string;
    passwordHash: string;
  }): Promise<'CREATED' | 'EMAIL_TAKEN'> {
    const row = await this.trx
      .insertInto('users')
      .values({ id: user.id, email: user.email, password_hash: user.passwordHash })
      .onConflict((conflict) => conflict.column('email').doNothing())
      .returning('id')
      .executeTakeFirst();
    return row ? 'CREATED' : 'EMAIL_TAKEN';
  }
}

export class PgOrderStore implements OrderStore {
  constructor(private readonly trx: Transaction<DB>) {}

  async insertIfAbsent(order: NewOrder): Promise<Inserted<OrderRecord>> {
    const row = await this.trx
      .insertInto('orders')
      .values(toOrderInsert(order))
      .onConflict((conflict) => conflict.columns(['user_id', 'client_order_id']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (row) return { inserted: true, value: toOrderRecord(row) };
    const existing = await this.trx
      .selectFrom('orders')
      .selectAll()
      .where('user_id', '=', order.userId)
      .where('client_order_id', '=', order.clientOrderId)
      .executeTakeFirstOrThrow();
    return { inserted: false, value: toOrderRecord(existing) };
  }

  async lockOwned(userId: string, orderId: string): Promise<OrderRecord | undefined> {
    const row = await this.trx
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    return row && toOrderRecord(row);
  }

  async lockMany(orderIds: readonly string[]): Promise<Map<string, OrderRecord>> {
    const rows = await this.trx
      .selectFrom('orders')
      .selectAll()
      .where('id', 'in', [...orderIds])
      .orderBy('id')
      .forUpdate()
      .execute();
    return new Map(rows.map((row) => [row.id, toOrderRecord(row)]));
  }

  async markCancelRequested(orderId: string, at: Date): Promise<OrderRecord> {
    const row = await this.trx
      .updateTable('orders')
      .set({ cancel_requested_at: at, updated_at: at })
      .where('id', '=', orderId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toOrderRecord(row);
  }

  async saveFunds(order: OrderFunds, at: Date, doneReason?: DoneReason): Promise<void> {
    await this.trx
      .updateTable('orders')
      .set({
        reserved_remaining: formatAmount(order.reservedRemaining),
        filled_quantity: formatAmount(order.filledQuantity),
        filled_quote: formatAmount(order.filledQuote),
        status: order.status,
        updated_at: at,
        ...(doneReason ? { done_reason: doneReason } : {}),
      })
      .where('id', '=', order.orderId)
      .execute();
  }
}

export class PgFillStore implements FillStore {
  constructor(private readonly trx: Transaction<DB>) {}

  async insert(fills: readonly Fill[]): Promise<void> {
    await this.trx.insertInto('fills').values(fills.map(toFillInsert)).execute();
  }
}

export class PgDepositStore implements DepositStore {
  constructor(private readonly trx: Transaction<DB>) {}

  async addressOwner(address: string): Promise<{ userId: string; asset: Asset } | undefined> {
    const row = await this.trx
      .selectFrom('deposit_addresses')
      .select(['user_id', 'asset'])
      .where('address', '=', address)
      .executeTakeFirst();
    return row && { userId: row.user_id, asset: asAsset(row.asset) };
  }

  // A concurrent duplicate blocks on the primary key until the first commits.
  async insertIfAbsent(deposit: DepositRecord, receivedAt: Date): Promise<Inserted<DepositRecord>> {
    const row = await this.trx
      .insertInto('deposits')
      .values({
        tx_id: deposit.txId,
        address: deposit.address,
        asset: deposit.asset,
        amount: formatAmount(deposit.amount),
        user_id: deposit.userId,
        status: deposit.status,
        received_at: receivedAt,
      })
      .onConflict((conflict) => conflict.column('tx_id').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (row) return { inserted: true, value: toDepositRecord(row) };
    const existing = await this.trx
      .selectFrom('deposits')
      .selectAll()
      .where('tx_id', '=', deposit.txId)
      .executeTakeFirstOrThrow();
    return { inserted: false, value: toDepositRecord(existing) };
  }

  async addressFor(userId: string, asset: Asset, candidate: string): Promise<string> {
    await this.trx
      .insertInto('deposit_addresses')
      .values({ address: candidate, user_id: userId, asset })
      .onConflict((conflict) => conflict.columns(['user_id', 'asset']).doNothing())
      .execute();
    const row = await this.trx
      .selectFrom('deposit_addresses')
      .select('address')
      .where('user_id', '=', userId)
      .where('asset', '=', asset)
      .executeTakeFirst();
    if (!row) throw new InvariantViolation(`No ${asset} address for ${userId}`);
    return row.address;
  }
}

export class PgCommandOutbox implements CommandOutbox {
  constructor(private readonly trx: Transaction<DB>) {}

  async enqueue(command: MatcherCommand): Promise<void> {
    await this.trx
      .insertInto('outbox')
      .values({
        topic: TOPICS.orderCommands,
        message_key: command.symbol,
        payload: Buffer.from(encodeCommand(command)),
        trace_parent: activeTraceCarrier().traceparent ?? null,
      })
      .execute();
  }
}

export class PgInbox implements Inbox {
  constructor(private readonly trx: Transaction<DB>) {}

  async remember(consumer: string, messageId: string): Promise<boolean> {
    const row = await this.trx
      .insertInto('inbox')
      .values({ consumer, event_id: messageId })
      .onConflict((conflict) => conflict.columns(['consumer', 'event_id']).doNothing())
      .returning('event_id')
      .executeTakeFirst();
    return row !== undefined;
  }
}
