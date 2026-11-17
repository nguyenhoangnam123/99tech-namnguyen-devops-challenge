import { findMarket, type Market } from '../src/markets.js';
import type { CancelCommand, MatcherEvent, PlaceCommand } from '../src/matching/messages.js';
import { parseAmount } from '../src/money.js';
import type { OrderSpec, Side, TimeInForce } from '../src/orders.js';

export const BTC: Market = findMarket('BTC-USDT') ?? raise('BTC-USDT market missing');

export const amt = parseAmount;

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}-${String(++sequence)}`;

interface LimitArgs {
  user: string;
  side: Side;
  price: string;
  quantity: string;
  timeInForce?: TimeInForce;
  orderId?: string;
}

export function limit(args: LimitArgs): PlaceCommand {
  return placeCommand(args.user, args.orderId, {
    type: 'LIMIT',
    symbol: BTC.symbol,
    side: args.side,
    timeInForce: args.timeInForce ?? 'GTC',
    price: amt(args.price),
    quantity: amt(args.quantity),
  });
}

export function marketSell(user: string, quantity: string): PlaceCommand {
  return placeCommand(user, undefined, {
    type: 'MARKET',
    symbol: BTC.symbol,
    side: 'SELL',
    quantity: amt(quantity),
  });
}

export function marketBuy(user: string, quoteQuantity: string): PlaceCommand {
  return placeCommand(user, undefined, {
    type: 'MARKET',
    symbol: BTC.symbol,
    side: 'BUY',
    quoteQuantity: amt(quoteQuantity),
  });
}

export function cancel(user: string, orderId: string): CancelCommand {
  return {
    kind: 'CANCEL',
    commandId: nextId('cmd'),
    symbol: BTC.symbol,
    issuedAt: '2026-11-17T00:00:00.000Z',
    orderId,
    userId: user,
  };
}

function placeCommand(user: string, orderId: string | undefined, spec: OrderSpec): PlaceCommand {
  return {
    kind: 'PLACE',
    commandId: nextId('cmd'),
    symbol: BTC.symbol,
    issuedAt: '2026-11-17T00:00:00.000Z',
    orderId: orderId ?? nextId('order'),
    userId: user,
    spec,
  };
}

export const kinds = (events: MatcherEvent[]): string[] => events.map((event) => event.kind);

export function only<K extends MatcherEvent['kind']>(
  events: MatcherEvent[],
  kind: K,
): Extract<MatcherEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<MatcherEvent, { kind: K }> => event.kind === kind);
}

function raise(message: string): never {
  throw new Error(message);
}
