import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { DB } from '@exchange/contracts';
import { type Asset, type MatcherEvent, parseAmount } from '@exchange/core';
import { type Database, createDatabase, createLogger, sql } from '@exchange/platform';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgReadModel } from '../../src/adapters/postgres/read-model.js';
import { PgUnitOfWork } from '../../src/adapters/postgres/unit-of-work.js';
import { DepositService } from '../../src/app/deposits.js';
import { OrderService } from '../../src/app/orders.js';
import { SettlementService } from '../../src/app/settlement.js';

// Use cases and adapters against a real Postgres with every migration applied.
const migrationsDir = new URL('../../../../contracts/db/migrations/', import.meta.url);
const migrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map(
    (file) => readFileSync(new URL(file, migrationsDir), 'utf8').split('-- migrate:down')[0] ?? '',
  );

const clock = { now: () => new Date() };
const ids = { uuid: () => randomUUID() };

let container: StartedPostgreSqlContainer;
let database: Database<DB>;
let uow: PgUnitOfWork;
let orders: OrderService;
let deposits: DepositService;
let settlement: SettlementService;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17.12-alpine').start();
  database = createDatabase<DB>(
    { url: container.getConnectionUri(), poolSize: 20, applicationName: 'integration' },
    createLogger('integration', 'silent'),
  );
  for (const migration of migrations) await sql.raw(migration).execute(database.db);
  uow = new PgUnitOfWork(database.db);
  const read = new PgReadModel(database.db);
  orders = new OrderService({ uow, read, ids, clock });
  deposits = new DepositService(uow, clock);
  settlement = new SettlementService(uow, clock);
}, 120_000);

afterAll(async () => {
  await database.close();
  await container.stop();
});

async function userWith(asset: Asset, amount: string): Promise<string> {
  const userId = randomUUID();
  const address = `addr-${userId}`;
  await uow.execute(async (tx) => {
    await tx.users.create({ id: userId, email: `${userId}@example.test`, passwordHash: 'unused' });
    await tx.ledger.openUserAccounts(userId);
    await tx.deposits.addressFor(userId, asset, address);
  });
  await deposits.record({ txId: `tx-${userId}`, address, asset, amount: parseAmount(amount) });
  return userId;
}

const balance = async (userId: string, asset: Asset) =>
  (await new PgReadModel(database.db).balances(userId)).find((b) => b.asset === asset);

const limit = (side: 'BUY' | 'SELL', price: string, quantity: string) => ({
  clientOrderId: randomUUID(),
  symbol: 'ETH-USDT',
  side,
  type: 'LIMIT' as const,
  price,
  quantity,
});

describe('settlement against Postgres', () => {
  it('applies a redelivered command batch exactly once', async () => {
    const seller = await userWith('ETH', '1');
    const buyer = await userWith('USDT', '1000');
    const ask = await orders.place(seller, limit('SELL', '100', '1'));
    const bid = await orders.place(buyer, limit('BUY', '100', '1'));
    if (!ask.ok || !bid.ok) throw new Error('orders must be accepted');
    const commandId = randomUUID();
    const base = { symbol: 'ETH-USDT', userId: '' };
    const events: MatcherEvent[] = [
      {
        kind: 'TRADE',
        eventId: `${commandId}:0`,
        symbol: 'ETH-USDT',
        price: parseAmount('100'),
        quantity: parseAmount('1'),
        takerSide: 'BUY',
        makerOrderId: ask.value.order.orderId,
        makerUserId: seller,
        takerOrderId: bid.value.order.orderId,
        takerUserId: buyer,
        executedAt: new Date().toISOString(),
      },
      {
        ...base,
        kind: 'ORDER_DONE',
        eventId: `${commandId}:1`,
        orderId: ask.value.order.orderId,
        userId: seller,
        status: 'FILLED',
        reason: 'FILLED',
      },
      {
        ...base,
        kind: 'ORDER_DONE',
        eventId: `${commandId}:2`,
        orderId: bid.value.order.orderId,
        userId: buyer,
        status: 'FILLED',
        reason: 'FILLED',
      },
    ];

    const outcomes = [
      await settlement.apply({ commandId, events }),
      await settlement.apply({ commandId, events }),
    ];

    expect(outcomes).toEqual(['APPLIED', 'DUPLICATE']);
    expect(await balance(buyer, 'ETH')).toMatchObject({
      available: parseAmount('0.999'),
      held: 0n,
    });
    expect(await balance(seller, 'USDT')).toMatchObject({
      available: parseAmount('99.9'),
      held: 0n,
    });
  });
});

describe('order placement against Postgres', () => {
  it('rolls back the order row and outbox command when funds are short', async () => {
    const buyer = await userWith('USDT', '50');
    const before = await database.db
      .selectFrom('outbox')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();

    const result = await orders.place(buyer, limit('BUY', '100', '1'));

    expect(result).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
    const placed = await database.db
      .selectFrom('orders')
      .selectAll()
      .where('user_id', '=', buyer)
      .execute();
    const after = await database.db
      .selectFrom('outbox')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(placed).toEqual([]);
    expect(after.n).toBe(before.n);
  });

  it('never overdraws under concurrent placements', async () => {
    const buyer = await userWith('USDT', '500');

    const results = await Promise.all(
      Array.from({ length: 12 }, () => orders.place(buyer, limit('BUY', '100', '1'))),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(await balance(buyer, 'USDT')).toMatchObject({ available: 0n, held: parseAmount('500') });
  });
});

describe('ledger guarantees in the schema', () => {
  it('refuses to commit an unbalanced journal', async () => {
    const userId = await userWith('BTC', '1');
    const insertOneSided = database.db.transaction().execute(async (trx) => {
      await sql`
        insert into journal_entries (journal_id, account_id, amount, reason, ref_id)
        select ${randomUUID()}, id, 1, 'DEPOSIT', 'forged' from accounts
        where owner_id = ${userId} and asset = 'BTC' and kind = 'AVAILABLE'`.execute(trx);
    });

    await expect(insertOneSided).rejects.toThrow(/not balanced/);
  });

  it('refuses to edit, delete or truncate journal entries', async () => {
    for (const statement of [
      'update journal_entries set amount = 0',
      'delete from journal_entries',
      'truncate journal_entries',
    ]) {
      await expect(sql.raw(statement).execute(database.db)).rejects.toThrow(/append-only/);
    }
  });

  it('credits a deposit once under 10 concurrent deliveries', async () => {
    const userId = randomUUID();
    const address = `addr-${userId}`;
    await uow.execute(async (tx) => {
      await tx.users.create({
        id: userId,
        email: `${userId}@example.test`,
        passwordHash: 'unused',
      });
      await tx.ledger.openUserAccounts(userId);
      await tx.deposits.addressFor(userId, 'ETH', address);
    });
    const notice = {
      txId: `tx-${randomUUID()}`,
      address,
      asset: 'ETH' as const,
      amount: parseAmount('2'),
    };

    const receipts = await Promise.all(Array.from({ length: 10 }, () => deposits.record(notice)));

    expect(receipts.filter((r) => r.ok && !r.value.duplicate)).toHaveLength(1);
    expect(await balance(userId, 'ETH')).toMatchObject({ available: parseAmount('2') });
  });
});
