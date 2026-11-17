import {
  type Fill,
  type OrderRejection,
  type OrderRequest,
  type Result,
  err,
  findMarket,
  holdJournal,
  isFinal,
  isSameOrderSpec,
  ok,
  reservationFor,
  validateOrder,
} from '@exchange/core';
import type {
  Clock,
  IdGenerator,
  OrderFilter,
  OrderRecord,
  ReadModel,
  UnitOfWork,
} from './ports.js';

export interface PlaceOrderInput extends OrderRequest {
  readonly clientOrderId: string;
}

export interface Placement {
  readonly order: OrderRecord;
  readonly replayed: boolean;
}

export type PlaceOrderError = OrderRejection | 'INSUFFICIENT_FUNDS' | 'CLIENT_ORDER_ID_REUSED';

export interface OrderDeps {
  readonly uow: UnitOfWork;
  readonly read: ReadModel;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export class OrderService {
  constructor(private readonly deps: OrderDeps) {}

  // Order row, fund hold and matcher command commit together or not at all.
  async place(userId: string, input: PlaceOrderInput): Promise<Result<Placement, PlaceOrderError>> {
    const validated = validateOrder(input);
    if (!validated.ok) return validated;
    const spec = validated.value;
    const market = findMarket(spec.symbol);
    if (!market) return err('UNKNOWN_SYMBOL');
    const { ids, clock } = this.deps;
    const now = clock.now();
    const reservation = reservationFor(spec, market);
    const orderId = ids.uuid();

    return this.deps.uow.run<Placement, PlaceOrderError>(async (tx) => {
      const { inserted, value: order } = await tx.orders.insertIfAbsent({
        id: orderId,
        userId,
        clientOrderId: input.clientOrderId,
        spec,
        reservation,
        createdAt: now,
      });
      if (!inserted) {
        return isSameOrderSpec(order.spec, spec)
          ? ok({ order, replayed: true })
          : err('CLIENT_ORDER_ID_REUSED');
      }
      if (
        (await tx.ledger.post(holdJournal(orderId, userId, reservation))) === 'INSUFFICIENT_FUNDS'
      ) {
        return err('INSUFFICIENT_FUNDS');
      }
      await tx.outbox.enqueue({
        kind: 'PLACE',
        commandId: ids.uuid(),
        symbol: spec.symbol,
        issuedAt: now.toISOString(),
        orderId,
        userId,
        spec,
      });
      return ok({ order, replayed: false });
    });
  }

  // Only requests the cancel; the matcher's ORDER_DONE settles the outcome.
  cancel(userId: string, orderId: string): Promise<Result<OrderRecord, 'ORDER_NOT_FOUND'>> {
    const { ids, clock } = this.deps;
    return this.deps.uow.run(async (tx) => {
      const order = await tx.orders.lockOwned(userId, orderId);
      if (!order) return err('ORDER_NOT_FOUND');
      if (isFinal(order.status) || order.cancelRequestedAt) return ok(order);
      const now = clock.now();
      const updated = await tx.orders.markCancelRequested(orderId, now);
      await tx.outbox.enqueue({
        kind: 'CANCEL',
        commandId: ids.uuid(),
        symbol: order.spec.symbol,
        issuedAt: now.toISOString(),
        orderId,
        userId,
      });
      return ok(updated);
    });
  }

  async get(userId: string, orderId: string): Promise<Result<OrderRecord, 'ORDER_NOT_FOUND'>> {
    const order = await this.deps.read.order(userId, orderId);
    return order ? ok(order) : err('ORDER_NOT_FOUND');
  }

  list(userId: string, filter: OrderFilter): Promise<OrderRecord[]> {
    return this.deps.read.orders(userId, filter);
  }

  fills(userId: string, filter: { symbol?: string | undefined; limit: number }): Promise<Fill[]> {
    return this.deps.read.fills(userId, filter);
  }
}
