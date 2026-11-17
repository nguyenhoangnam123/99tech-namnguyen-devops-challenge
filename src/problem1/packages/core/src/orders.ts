import { type Asset, type Market, findMarket } from './markets.js';
import { type Amount, isMultipleOf, mulDown, tryParseAmount } from './money.js';
import { type Result, err, ok } from './result.js';

export type Side = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET';
export type TimeInForce = 'GTC' | 'IOC';
export type OrderStatus = 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'EXPIRED';
export type FinalStatus = Extract<OrderStatus, 'FILLED' | 'CANCELLED' | 'EXPIRED'>;
export type DoneReason = 'FILLED' | 'USER_CANCEL' | 'IOC_REMAINDER' | 'SELF_TRADE' | 'NO_LIQUIDITY';

export interface LimitOrderSpec {
  readonly type: 'LIMIT';
  readonly symbol: string;
  readonly side: Side;
  readonly timeInForce: TimeInForce;
  readonly price: Amount;
  readonly quantity: Amount;
}

export interface MarketSellSpec {
  readonly type: 'MARKET';
  readonly symbol: string;
  readonly side: 'SELL';
  readonly quantity: Amount;
}

// Market buys spend a quote budget, so the hold is known up front.
export interface MarketBuySpec {
  readonly type: 'MARKET';
  readonly symbol: string;
  readonly side: 'BUY';
  readonly quoteQuantity: Amount;
}

export type OrderSpec = LimitOrderSpec | MarketSellSpec | MarketBuySpec;

export interface OrderRequest {
  readonly symbol: string;
  readonly side: Side;
  readonly type: OrderType;
  readonly timeInForce?: TimeInForce | undefined;
  readonly price?: string | undefined;
  readonly quantity?: string | undefined;
  readonly quoteQuantity?: string | undefined;
}

export type OrderRejection =
  | 'UNKNOWN_SYMBOL'
  | 'INVALID_ORDER_SHAPE'
  | 'INVALID_PRICE'
  | 'INVALID_QUANTITY'
  | 'BELOW_MIN_NOTIONAL'
  | 'ABOVE_MAX_NOTIONAL';

export interface Reservation {
  readonly asset: Asset;
  readonly amount: Amount;
}

export function validateOrder(request: OrderRequest): Result<OrderSpec, OrderRejection> {
  const market = findMarket(request.symbol);
  if (!market) return err('UNKNOWN_SYMBOL');
  if (request.type === 'LIMIT') return validateLimit(request, market);
  return request.side === 'SELL'
    ? validateMarketSell(request, market)
    : validateMarketBuy(request, market);
}

function validateLimit(
  request: OrderRequest,
  market: Market,
): Result<LimitOrderSpec, OrderRejection> {
  if (
    request.price === undefined ||
    request.quantity === undefined ||
    request.quoteQuantity !== undefined
  ) {
    return err('INVALID_ORDER_SHAPE');
  }
  const price = parseStep(request.price, market.tickSize, market.maxPrice);
  if (price === undefined) return err('INVALID_PRICE');
  const quantity = parseStep(request.quantity, market.lotSize, market.maxQuantity);
  if (quantity === undefined) return err('INVALID_QUANTITY');
  if (mulDown(price, quantity) < market.minNotional) return err('BELOW_MIN_NOTIONAL');
  return ok({
    type: 'LIMIT',
    symbol: market.symbol,
    side: request.side,
    timeInForce: request.timeInForce ?? 'GTC',
    price,
    quantity,
  });
}

function validateMarketSell(
  request: OrderRequest,
  market: Market,
): Result<MarketSellSpec, OrderRejection> {
  if (!isMarketShape(request) || request.quantity === undefined) return err('INVALID_ORDER_SHAPE');
  const quantity = parseStep(request.quantity, market.lotSize, market.maxQuantity);
  if (quantity === undefined) return err('INVALID_QUANTITY');
  return ok({ type: 'MARKET', symbol: market.symbol, side: 'SELL', quantity });
}

function validateMarketBuy(
  request: OrderRequest,
  market: Market,
): Result<MarketBuySpec, OrderRejection> {
  if (!isMarketShape(request) || request.quoteQuantity === undefined)
    return err('INVALID_ORDER_SHAPE');
  const quoteQuantity = tryParseAmount(request.quoteQuantity);
  if (quoteQuantity === undefined || quoteQuantity <= 0n) return err('INVALID_QUANTITY');
  if (quoteQuantity < market.minNotional) return err('BELOW_MIN_NOTIONAL');
  if (quoteQuantity > mulDown(market.maxPrice, market.maxQuantity))
    return err('ABOVE_MAX_NOTIONAL');
  return ok({ type: 'MARKET', symbol: market.symbol, side: 'BUY', quoteQuantity });
}

// Market orders take exactly one size field and never a price.
function isMarketShape(request: OrderRequest): boolean {
  const sizeFields = [request.quantity, request.quoteQuantity].filter((v) => v !== undefined);
  return request.price === undefined && request.timeInForce !== 'GTC' && sizeFields.length === 1;
}

function parseStep(text: string, step: Amount, max: Amount): Amount | undefined {
  const amount = tryParseAmount(text);
  if (amount === undefined || amount <= 0n || amount > max || !isMultipleOf(amount, step)) {
    return undefined;
  }
  return amount;
}

export function timeInForceOf(spec: OrderSpec): TimeInForce {
  return spec.type === 'LIMIT' ? spec.timeInForce : 'IOC';
}

export function reservationFor(spec: OrderSpec, market: Market): Reservation {
  if (spec.type === 'LIMIT') {
    return spec.side === 'BUY'
      ? { asset: market.quote, amount: mulDown(spec.price, spec.quantity) }
      : { asset: market.base, amount: spec.quantity };
  }
  return spec.side === 'BUY'
    ? { asset: market.quote, amount: spec.quoteQuantity }
    : { asset: market.base, amount: spec.quantity };
}

// Two requests with one clientOrderId must describe the same order.
export function isSameOrderSpec(a: OrderSpec, b: OrderSpec): boolean {
  return (
    a.type === b.type &&
    a.symbol === b.symbol &&
    a.side === b.side &&
    timeInForceOf(a) === timeInForceOf(b) &&
    priceOf(a) === priceOf(b) &&
    quantityOf(a) === quantityOf(b) &&
    quoteQuantityOf(a) === quoteQuantityOf(b)
  );
}

export function priceOf(spec: OrderSpec): Amount | undefined {
  return spec.type === 'LIMIT' ? spec.price : undefined;
}

export function quantityOf(spec: OrderSpec): Amount | undefined {
  return 'quantity' in spec ? spec.quantity : undefined;
}

export function quoteQuantityOf(spec: OrderSpec): Amount | undefined {
  return 'quoteQuantity' in spec ? spec.quoteQuantity : undefined;
}
