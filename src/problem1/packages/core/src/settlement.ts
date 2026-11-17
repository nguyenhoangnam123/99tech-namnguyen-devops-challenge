import { exchangeAccount, journal, type Journal, releaseJournal, userAccount } from './ledger.js';
import type { Asset, Market } from './markets.js';
import type { TradeEvent } from './matching/messages.js';
import { type Amount, mulDown } from './money.js';
import type { FinalStatus, OrderStatus, Side } from './orders.js';
import { InvariantViolation } from './result.js';

export type LiquidityRole = 'MAKER' | 'TAKER';

// The slice of an order that settlement reads and rewrites.
export interface OrderFunds {
  readonly orderId: string;
  readonly userId: string;
  readonly symbol: string;
  readonly side: Side;
  // Null for market orders; a market buy is bounded by its hold instead.
  readonly limitPrice: Amount | null;
  readonly orderQuantity: Amount | null;
  readonly reservedAsset: Asset;
  readonly reservedRemaining: Amount;
  readonly filledQuantity: Amount;
  readonly filledQuote: Amount;
  readonly status: OrderStatus;
}

export interface Fill {
  readonly tradeId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly role: LiquidityRole;
  readonly price: Amount;
  readonly quantity: Amount;
  readonly fee: Amount;
  readonly feeAsset: Asset;
  readonly executedAt: string;
}

export interface TradeSettlement {
  readonly journal: Journal;
  readonly fills: readonly [Fill, Fill];
  readonly maker: OrderFunds;
  readonly taker: OrderFunds;
}

export interface OrderClosure {
  readonly journal: Journal | undefined;
  readonly order: OrderFunds;
}

const FINAL_STATUSES: readonly OrderStatus[] = ['FILLED', 'CANCELLED', 'EXPIRED'];

export const isFinal = (status: OrderStatus): boolean => FINAL_STATUSES.includes(status);

// Fees are charged in the asset each side receives.
export function settleTrade(
  trade: TradeEvent,
  maker: OrderFunds,
  taker: OrderFunds,
  market: Market,
): TradeSettlement {
  assertParties(trade, maker, taker);
  const notional = mulDown(trade.price, trade.quantity);
  const [buyer, seller] = trade.takerSide === 'BUY' ? [taker, maker] : [maker, taker];
  const buyerRole = roleOf(buyer, trade);
  const sellerRole = roleOf(seller, trade);
  const buyerFee = mulDown(trade.quantity, feeRate(market, buyerRole));
  const sellerFee = mulDown(notional, feeRate(market, sellerRole));

  const tradeJournal = journal('TRADE', trade.eventId, [
    { account: userAccount(buyer.userId, market.quote, 'HELD'), amount: -notional },
    {
      account: userAccount(buyer.userId, market.base, 'AVAILABLE'),
      amount: trade.quantity - buyerFee,
    },
    { account: exchangeAccount(market.base, 'FEES'), amount: buyerFee },
    { account: userAccount(seller.userId, market.base, 'HELD'), amount: -trade.quantity },
    {
      account: userAccount(seller.userId, market.quote, 'AVAILABLE'),
      amount: notional - sellerFee,
    },
    { account: exchangeAccount(market.quote, 'FEES'), amount: sellerFee },
  ]);

  const buyerAfter = consume(buyer, notional, trade.quantity, notional);
  const sellerAfter = consume(seller, trade.quantity, trade.quantity, notional);

  return {
    journal: tradeJournal,
    fills: [
      fillOf(trade, buyer, buyerRole, buyerFee, market.base),
      fillOf(trade, seller, sellerRole, sellerFee, market.quote),
    ],
    maker: trade.takerSide === 'BUY' ? sellerAfter : buyerAfter,
    taker: trade.takerSide === 'BUY' ? buyerAfter : sellerAfter,
  };
}

// Releases whatever is still held once the matcher is done with the order.
export function closeOrder(order: OrderFunds, status: FinalStatus): OrderClosure {
  if (isFinal(order.status)) throw new InvariantViolation(`Order ${order.orderId} closed twice`);
  const release =
    order.reservedRemaining > 0n
      ? releaseJournal(order.orderId, order.userId, {
          asset: order.reservedAsset,
          amount: order.reservedRemaining,
        })
      : undefined;
  return { journal: release, order: { ...order, reservedRemaining: 0n, status } };
}

function assertParties(trade: TradeEvent, maker: OrderFunds, taker: OrderFunds): void {
  const matches =
    maker.orderId === trade.makerOrderId &&
    taker.orderId === trade.takerOrderId &&
    taker.side === trade.takerSide &&
    maker.side !== taker.side;
  if (!matches) throw new InvariantViolation(`Trade ${trade.eventId} does not match its orders`);
  if (isFinal(maker.status) || isFinal(taker.status)) {
    throw new InvariantViolation(`Trade ${trade.eventId} hits a closed order`);
  }
  // Price-time priority always trades at the resting maker's price.
  if (trade.price !== maker.limitPrice) {
    throw new InvariantViolation(`Trade ${trade.eventId} is not at the maker's price`);
  }
  for (const order of [maker, taker]) assertWithinTerms(trade, order);
}

// The matcher is trusted, not blindly: a trade outside an order's own
// terms stops the line instead of moving money.
function assertWithinTerms(trade: TradeEvent, order: OrderFunds): void {
  const { limitPrice, orderQuantity } = order;
  const priceOk =
    limitPrice === null ||
    (order.side === 'BUY' ? trade.price <= limitPrice : trade.price >= limitPrice);
  const sizeOk = orderQuantity === null || order.filledQuantity + trade.quantity <= orderQuantity;
  if (order.symbol !== trade.symbol || !priceOk || !sizeOk) {
    throw new InvariantViolation(`Trade ${trade.eventId} breaks the terms of ${order.orderId}`);
  }
}

function consume(order: OrderFunds, used: Amount, quantity: Amount, notional: Amount): OrderFunds {
  const reservedRemaining = order.reservedRemaining - used;
  if (reservedRemaining < 0n)
    throw new InvariantViolation(`Order ${order.orderId} overspent its hold`);
  return {
    ...order,
    reservedRemaining,
    filledQuantity: order.filledQuantity + quantity,
    filledQuote: order.filledQuote + notional,
    status: 'PARTIALLY_FILLED',
  };
}

function roleOf(order: OrderFunds, trade: TradeEvent): LiquidityRole {
  return order.orderId === trade.makerOrderId ? 'MAKER' : 'TAKER';
}

function feeRate(market: Market, role: LiquidityRole): Amount {
  return role === 'MAKER' ? market.makerFeeRate : market.takerFeeRate;
}

function fillOf(
  trade: TradeEvent,
  order: OrderFunds,
  role: LiquidityRole,
  fee: Amount,
  feeAsset: Asset,
): Fill {
  return {
    tradeId: trade.eventId,
    orderId: order.orderId,
    userId: order.userId,
    symbol: trade.symbol,
    side: order.side,
    role,
    price: trade.price,
    quantity: trade.quantity,
    fee,
    feeAsset,
    executedAt: trade.executedAt,
  };
}
