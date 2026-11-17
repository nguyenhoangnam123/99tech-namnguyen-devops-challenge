import {
  InvariantViolation,
  type MatcherEvent,
  accountsTouched,
  type OrderDoneEvent,
  type TradeEvent,
  closeOrder,
  findMarket,
  type Journal,
  settleTrade,
} from '@exchange/core';
import type { Clock, OrderRecord, TransactionPorts, UnitOfWork } from './ports.js';

export const SETTLER_CONSUMER = 'oms-settler';

export interface CommandEvents {
  readonly commandId: string;
  readonly events: readonly MatcherEvent[];
}

// Applies one matcher command's events in one transaction.
// The inbox makes redelivery a no-op.
export class SettlementService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  apply(batch: CommandEvents): Promise<'APPLIED' | 'DUPLICATE'> {
    return this.uow.execute(async (tx) => {
      if (!(await tx.inbox.remember(SETTLER_CONSUMER, batch.commandId))) return 'DUPLICATE';
      await tx.ledger.lock(accountsTouched(batch.events));
      for (const event of batch.events) {
        if (event.kind === 'TRADE') await this.settle(tx, event);
        if (event.kind === 'ORDER_DONE') await this.close(tx, event);
      }
      return 'APPLIED';
    });
  }

  private async settle(tx: TransactionPorts, trade: TradeEvent): Promise<void> {
    const market = findMarket(trade.symbol);
    if (!market) throw new InvariantViolation(`Unknown market ${trade.symbol}`);
    const orders = await tx.orders.lockMany([trade.makerOrderId, trade.takerOrderId]);
    const settlement = settleTrade(
      trade,
      required(orders, trade.makerOrderId),
      required(orders, trade.takerOrderId),
      market,
    );
    await post(tx, settlement.journal);
    const now = this.clock.now();
    await tx.orders.saveFunds(settlement.maker, now);
    await tx.orders.saveFunds(settlement.taker, now);
    await tx.fills.insert(settlement.fills);
  }

  private async close(tx: TransactionPorts, done: OrderDoneEvent): Promise<void> {
    const orders = await tx.orders.lockMany([done.orderId]);
    const closure = closeOrder(required(orders, done.orderId), done.status);
    if (closure.journal) await post(tx, closure.journal);
    await tx.orders.saveFunds(closure.order, this.clock.now(), done.reason);
  }
}

// Settlement only moves funds that are already held, so a shortfall is a bug.
async function post(tx: TransactionPorts, journal: Journal): Promise<void> {
  const outcome = await tx.ledger.post(journal);
  if (outcome !== 'POSTED')
    throw new InvariantViolation(`Journal ${journal.refId} overdraws a hold`);
}

function required(orders: Map<string, OrderRecord>, orderId: string): OrderRecord {
  const order = orders.get(orderId);
  if (!order) throw new InvariantViolation(`Event references unknown order ${orderId}`);
  return order;
}
