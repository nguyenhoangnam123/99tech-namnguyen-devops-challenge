import { describe, expect, it } from 'vitest';
import type { Journal, Posting } from '../src/ledger.js';
import type { TradeEvent } from '../src/matching/messages.js';
import { InvariantViolation } from '../src/result.js';
import { closeOrder, type OrderFunds, settleTrade } from '../src/settlement.js';
import { BTC, amt } from './fixtures.js';

const trade: TradeEvent = {
  kind: 'TRADE',
  eventId: 'cmd-9:0',
  symbol: 'BTC-USDT',
  price: amt('100'),
  quantity: amt('2'),
  takerSide: 'BUY',
  makerOrderId: 'ask',
  makerUserId: 'seller',
  takerOrderId: 'bid',
  takerUserId: 'buyer',
  executedAt: '2026-11-17T00:00:00.000Z',
};

const ask: OrderFunds = {
  orderId: 'ask',
  userId: 'seller',
  symbol: 'BTC-USDT',
  side: 'SELL',
  limitPrice: amt('100'),
  orderQuantity: amt('5'),
  reservedAsset: 'BTC',
  reservedRemaining: amt('5'),
  filledQuantity: 0n,
  filledQuote: 0n,
  status: 'NEW',
};

// Limit 110 bid: holds 220, trades at 100, so 20 stays held.
const bid: OrderFunds = {
  orderId: 'bid',
  userId: 'buyer',
  symbol: 'BTC-USDT',
  side: 'BUY',
  limitPrice: amt('110'),
  orderQuantity: amt('2'),
  reservedAsset: 'USDT',
  reservedRemaining: amt('220'),
  filledQuantity: 0n,
  filledQuote: 0n,
  status: 'NEW',
};

const describePostings = (journal: Journal): string[] =>
  journal.postings.map(
    ({ account, amount }: Posting) =>
      `${account.owner ?? 'exchange'}:${account.asset}:${account.kind} ${amount}`,
  );

describe('settleTrade', () => {
  it('moves held funds to the counterparty and charges fees in the received asset', () => {
    const result = settleTrade(trade, ask, bid, BTC);

    expect(describePostings(result.journal)).toEqual([
      `buyer:USDT:HELD ${-amt('200')}`,
      `buyer:BTC:AVAILABLE ${amt('1.998')}`,
      `exchange:BTC:FEES ${amt('0.002')}`,
      `seller:BTC:HELD ${-amt('2')}`,
      `seller:USDT:AVAILABLE ${amt('199.8')}`,
      `exchange:USDT:FEES ${amt('0.2')}`,
    ]);
    expect(result.journal).toMatchObject({ reason: 'TRADE', refId: trade.eventId });
  });

  it('reduces each hold by what the trade consumed', () => {
    const result = settleTrade(trade, ask, bid, BTC);

    expect(result.taker).toMatchObject({
      reservedRemaining: amt('20'),
      filledQuantity: amt('2'),
      filledQuote: amt('200'),
      status: 'PARTIALLY_FILLED',
    });
    expect(result.maker).toMatchObject({ reservedRemaining: amt('3'), filledQuantity: amt('2') });
  });

  it('records one fill per side with its role and fee', () => {
    const [buyerFill, sellerFill] = settleTrade(trade, ask, bid, BTC).fills;

    expect(buyerFill).toMatchObject({
      orderId: 'bid',
      role: 'TAKER',
      fee: amt('0.002'),
      feeAsset: 'BTC',
    });
    expect(sellerFill).toMatchObject({
      orderId: 'ask',
      role: 'MAKER',
      fee: amt('0.2'),
      feeAsset: 'USDT',
    });
  });

  it('stops the line when a trade would overspend a hold', () => {
    const thin = { ...bid, reservedRemaining: amt('199.99') };
    expect(() => settleTrade(trade, ask, thin, BTC)).toThrow(InvariantViolation);
  });

  it.each<[string, Partial<TradeEvent>, Partial<OrderFunds>, Partial<OrderFunds>]>([
    ['above the buy limit', { price: amt('111') }, { limitPrice: amt('111') }, {}],
    ['below the sell limit', { price: amt('99') }, {}, {}],
    ['beyond the order size', {}, {}, { orderQuantity: amt('1.5') }],
    ['on another market', { symbol: 'ETH-USDT' }, {}, {}],
    ['against a market maker', {}, { limitPrice: null }, {}],
  ])('stops the line on a trade %s', (_label, tradePatch, makerPatch, takerPatch) => {
    expect(() =>
      settleTrade(
        { ...trade, ...tradePatch },
        { ...ask, ...makerPatch },
        { ...bid, ...takerPatch },
        BTC,
      ),
    ).toThrow(InvariantViolation);
  });

  it('refuses trades that do not match their orders', () => {
    expect(() => settleTrade(trade, bid, ask, BTC)).toThrow(InvariantViolation);
    expect(() => settleTrade(trade, { ...ask, status: 'FILLED' }, bid, BTC)).toThrow(
      InvariantViolation,
    );
  });
});

describe('closeOrder', () => {
  it('releases the remaining hold back to available', () => {
    const { journal, order } = closeOrder({ ...bid, reservedRemaining: amt('20') }, 'FILLED');

    expect(journal && describePostings(journal)).toEqual([
      `buyer:USDT:HELD ${-amt('20')}`,
      `buyer:USDT:AVAILABLE ${amt('20')}`,
    ]);
    expect(order).toMatchObject({ status: 'FILLED', reservedRemaining: 0n });
  });

  it('writes no journal when nothing is held', () => {
    expect(closeOrder({ ...ask, reservedRemaining: 0n }, 'FILLED').journal).toBeUndefined();
  });

  it('refuses to close an order twice', () => {
    expect(() => closeOrder({ ...ask, status: 'CANCELLED' }, 'CANCELLED')).toThrow(
      InvariantViolation,
    );
  });
});
