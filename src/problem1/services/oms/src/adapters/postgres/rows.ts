import type { DB } from '@exchange/contracts';
import {
  ASSETS,
  type Asset,
  type DoneReason,
  type Fill,
  InvariantViolation,
  type OrderSpec,
  type OrderStatus,
  type Side,
  formatAmount,
  parseAmount,
} from '@exchange/core';
import type { Insertable, Selectable } from 'kysely';
import type { DepositRecord, DepositStatus, NewOrder, OrderRecord } from '../../app/ports.js';

export type OrderRow = Selectable<DB['orders']>;
export type FillRow = Selectable<DB['fills']>;
export type DepositRow = Selectable<DB['deposits']>;

const SIDES = ['BUY', 'SELL'] as const;
const STATUSES = ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED'] as const;
const DONE_REASONS = [
  'FILLED',
  'USER_CANCEL',
  'IOC_REMAINDER',
  'SELF_TRADE',
  'NO_LIQUIDITY',
  'FILL_LIMIT',
] as const;
const ROLES = ['MAKER', 'TAKER'] as const;
const DEPOSIT_STATUSES = ['CREDITED', 'UNMATCHED'] as const;

// Narrows a text column to its union; the CHECK constraints make misses a bug.
function oneOf<T extends string>(allowed: readonly T[], value: string, column: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new InvariantViolation(`Unexpected ${column}: ${value}`);
}

const optional = (value: string | null): bigint | undefined =>
  value === null ? undefined : parseAmount(value);

export const asAsset = (value: string): Asset => oneOf(ASSETS, value, 'asset');

export function toOrderRecord(row: OrderRow): OrderRecord {
  const side = oneOf<Side>(SIDES, row.side, 'side');
  const spec = specOf(row, side);
  return {
    orderId: row.id,
    userId: row.user_id,
    clientOrderId: row.client_order_id,
    symbol: row.symbol,
    side,
    spec,
    limitPrice: optional(row.price) ?? null,
    orderQuantity: optional(row.quantity) ?? null,
    reservation: { asset: asAsset(row.reserved_asset), amount: parseAmount(row.reserved) },
    reservedAsset: asAsset(row.reserved_asset),
    reservedRemaining: parseAmount(row.reserved_remaining),
    filledQuantity: parseAmount(row.filled_quantity),
    filledQuote: parseAmount(row.filled_quote),
    status: oneOf<OrderStatus>(STATUSES, row.status, 'status'),
    doneReason:
      row.done_reason === null
        ? null
        : oneOf<DoneReason>(DONE_REASONS, row.done_reason, 'done_reason'),
    cancelRequestedAt: row.cancel_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function specOf(row: OrderRow, side: Side): OrderSpec {
  const price = optional(row.price);
  const quantity = optional(row.quantity);
  const quoteQuantity = optional(row.quote_quantity);
  if (row.type === 'LIMIT' && price !== undefined && quantity !== undefined) {
    const timeInForce = oneOf(['GTC', 'IOC'] as const, row.time_in_force, 'time_in_force');
    return { type: 'LIMIT', symbol: row.symbol, side, timeInForce, price, quantity };
  }
  if (row.type === 'MARKET' && side === 'BUY' && quoteQuantity !== undefined) {
    return { type: 'MARKET', symbol: row.symbol, side, quoteQuantity };
  }
  if (row.type === 'MARKET' && side === 'SELL' && quantity !== undefined) {
    return { type: 'MARKET', symbol: row.symbol, side, quantity };
  }
  throw new InvariantViolation(`Order ${row.id} has an impossible shape`);
}

export function toOrderInsert(order: NewOrder): Insertable<DB['orders']> {
  const { spec, reservation } = order;
  const amount = (value: bigint | undefined): string | null =>
    value === undefined ? null : formatAmount(value);
  return {
    id: order.id,
    user_id: order.userId,
    client_order_id: order.clientOrderId,
    symbol: spec.symbol,
    side: spec.side,
    type: spec.type,
    time_in_force: spec.type === 'LIMIT' ? spec.timeInForce : 'IOC',
    price: amount(spec.type === 'LIMIT' ? spec.price : undefined),
    quantity: amount('quantity' in spec ? spec.quantity : undefined),
    quote_quantity: amount('quoteQuantity' in spec ? spec.quoteQuantity : undefined),
    reserved_asset: reservation.asset,
    reserved: formatAmount(reservation.amount),
    reserved_remaining: formatAmount(reservation.amount),
    status: 'NEW',
    created_at: order.createdAt,
    updated_at: order.createdAt,
  };
}

export function toFill(row: FillRow): Fill {
  return {
    tradeId: row.trade_id,
    orderId: row.order_id,
    userId: row.user_id,
    symbol: row.symbol,
    side: oneOf<Side>(SIDES, row.side, 'side'),
    role: oneOf(ROLES, row.role, 'role'),
    price: parseAmount(row.price),
    quantity: parseAmount(row.quantity),
    fee: parseAmount(row.fee),
    feeAsset: asAsset(row.fee_asset),
    executedAt: row.executed_at.toISOString(),
  };
}

export function toFillInsert(fill: Fill): Insertable<DB['fills']> {
  return {
    trade_id: fill.tradeId,
    order_id: fill.orderId,
    user_id: fill.userId,
    symbol: fill.symbol,
    side: fill.side,
    role: fill.role,
    price: formatAmount(fill.price),
    quantity: formatAmount(fill.quantity),
    fee: formatAmount(fill.fee),
    fee_asset: fill.feeAsset,
    executed_at: fill.executedAt,
  };
}

export function toDepositRecord(row: DepositRow): DepositRecord {
  return {
    txId: row.tx_id,
    address: row.address,
    asset: asAsset(row.asset),
    amount: parseAmount(row.amount),
    userId: row.user_id,
    status: oneOf<DepositStatus>(DEPOSIT_STATUSES, row.status, 'deposit status'),
  };
}
