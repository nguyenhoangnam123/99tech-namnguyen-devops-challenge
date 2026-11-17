import { describe, expect, it } from 'vitest';
import {
  isSameOrderSpec,
  type OrderRequest,
  reservationFor,
  validateOrder,
} from '../src/orders.js';
import { BTC, amt } from './fixtures.js';

const limitBuy: OrderRequest = {
  symbol: 'BTC-USDT',
  side: 'BUY',
  type: 'LIMIT',
  price: '60000.01',
  quantity: '0.001',
};

describe('validateOrder', () => {
  it('accepts a well formed limit order and defaults to GTC', () => {
    const result = validateOrder(limitBuy);
    expect(result).toEqual({
      ok: true,
      value: {
        type: 'LIMIT',
        symbol: 'BTC-USDT',
        side: 'BUY',
        timeInForce: 'GTC',
        price: amt('60000.01'),
        quantity: amt('0.001'),
      },
    });
  });

  it.each<[string, Partial<OrderRequest>, string]>([
    ['unknown symbol', { symbol: 'DOGE-USDT' }, 'UNKNOWN_SYMBOL'],
    ['missing price', { price: undefined }, 'INVALID_ORDER_SHAPE'],
    ['quote size on a limit', { quoteQuantity: '10' }, 'INVALID_ORDER_SHAPE'],
    ['off-tick price', { price: '60000.001' }, 'INVALID_PRICE'],
    ['zero price', { price: '0' }, 'INVALID_PRICE'],
    ['price above max', { price: '10000000.01' }, 'INVALID_PRICE'],
    ['off-lot quantity', { quantity: '0.000001' }, 'INVALID_QUANTITY'],
    ['quantity above max', { quantity: '1000.00001' }, 'INVALID_QUANTITY'],
    ['negative quantity', { quantity: '-1' }, 'INVALID_QUANTITY'],
    ['dust notional', { price: '1', quantity: '0.001' }, 'BELOW_MIN_NOTIONAL'],
  ])('rejects %s', (_label, patch, error) => {
    expect(validateOrder({ ...limitBuy, ...patch })).toEqual({ ok: false, error });
  });

  it('requires a quote budget for market buys and a quantity for market sells', () => {
    const market = { symbol: 'BTC-USDT', type: 'MARKET' } as const;
    expect(validateOrder({ ...market, side: 'BUY', quoteQuantity: '100' }).ok).toBe(true);
    expect(validateOrder({ ...market, side: 'SELL', quantity: '0.5' }).ok).toBe(true);
    expect(validateOrder({ ...market, side: 'BUY', quantity: '0.5' })).toEqual({
      ok: false,
      error: 'INVALID_ORDER_SHAPE',
    });
    expect(validateOrder({ ...market, side: 'SELL', quantity: '0.5', price: '1' })).toEqual({
      ok: false,
      error: 'INVALID_ORDER_SHAPE',
    });
    expect(validateOrder({ ...market, side: 'BUY', quoteQuantity: '1' })).toEqual({
      ok: false,
      error: 'BELOW_MIN_NOTIONAL',
    });
  });

  it('rejects GTC on market orders', () => {
    const request: OrderRequest = {
      symbol: 'BTC-USDT',
      type: 'MARKET',
      side: 'SELL',
      quantity: '1',
      timeInForce: 'GTC',
    };
    expect(validateOrder(request)).toEqual({ ok: false, error: 'INVALID_ORDER_SHAPE' });
  });
});

describe('reservationFor', () => {
  it('holds quote for buys and base for sells', () => {
    const buy = validateOrder(limitBuy);
    const sell = validateOrder({ ...limitBuy, side: 'SELL' });
    const marketBuy = validateOrder({
      symbol: 'BTC-USDT',
      type: 'MARKET',
      side: 'BUY',
      quoteQuantity: '250',
    });
    if (!buy.ok || !sell.ok || !marketBuy.ok) throw new Error('fixtures must validate');

    expect(reservationFor(buy.value, BTC)).toEqual({ asset: 'USDT', amount: amt('60.00001') });
    expect(reservationFor(sell.value, BTC)).toEqual({ asset: 'BTC', amount: amt('0.001') });
    expect(reservationFor(marketBuy.value, BTC)).toEqual({ asset: 'USDT', amount: amt('250') });
  });
});

describe('isSameOrderSpec', () => {
  it('detects a reused client order id with different terms', () => {
    const a = validateOrder(limitBuy);
    const b = validateOrder({ ...limitBuy, price: '60000.02' });
    if (!a.ok || !b.ok) throw new Error('fixtures must validate');
    expect(isSameOrderSpec(a.value, a.value)).toBe(true);
    expect(isSameOrderSpec(a.value, b.value)).toBe(false);
  });
});
