import { beforeEach, describe, expect, it } from 'vitest';
import { MatchingEngine } from '../src/matching/engine.js';
import { BTC, amt, cancel, kinds, limit, marketBuy, marketSell, only } from './fixtures.js';

describe('MatchingEngine', () => {
  let engine: MatchingEngine;

  beforeEach(() => {
    engine = new MatchingEngine(BTC);
  });

  it('rests a non-crossing limit order and publishes its level', () => {
    const events = engine.handle(
      limit({ user: 'alice', side: 'BUY', price: '100', quantity: '1' }),
    );

    expect(kinds(events)).toEqual(['BOOK_LEVEL']);
    expect(engine.depth(5).bids).toEqual([[amt('100'), amt('1')]]);
  });

  it('fills at the maker price and closes both orders', () => {
    const ask = limit({ user: 'alice', side: 'SELL', price: '100', quantity: '1' });
    engine.handle(ask);
    const bid = limit({ user: 'bob', side: 'BUY', price: '105', quantity: '1' });

    const events = engine.handle(bid);

    expect(kinds(events)).toEqual(['TRADE', 'ORDER_DONE', 'ORDER_DONE', 'BOOK_LEVEL']);
    const [trade] = only(events, 'TRADE');
    expect(trade).toMatchObject({
      eventId: `${bid.commandId}:0`,
      price: amt('100'),
      quantity: amt('1'),
      takerSide: 'BUY',
      makerOrderId: ask.orderId,
      takerOrderId: bid.orderId,
      executedAt: bid.issuedAt,
    });
    expect(only(events, 'ORDER_DONE').map((e) => [e.orderId, e.status])).toEqual([
      [ask.orderId, 'FILLED'],
      [bid.orderId, 'FILLED'],
    ]);
    expect(only(events, 'BOOK_LEVEL')).toMatchObject([
      { side: 'SELL', price: amt('100'), quantity: 0n },
    ]);
  });

  it('honours price, then time priority across levels', () => {
    const late = limit({ user: 'a', side: 'SELL', price: '101', quantity: '1' });
    const early = limit({ user: 'b', side: 'SELL', price: '101', quantity: '1' });
    const best = limit({ user: 'c', side: 'SELL', price: '100', quantity: '1' });
    engine.handle(early);
    engine.handle(late);
    engine.handle(best);

    const events = engine.handle(limit({ user: 'd', side: 'BUY', price: '101', quantity: '2.5' }));

    expect(only(events, 'TRADE').map((t) => t.makerOrderId)).toEqual([
      best.orderId,
      early.orderId,
      late.orderId,
    ]);
    expect(only(events, 'TRADE').map((t) => t.quantity)).toEqual([amt('1'), amt('1'), amt('0.5')]);
    expect(engine.depth(5).asks).toEqual([[amt('101'), amt('0.5')]]);
  });

  it('rests the unfilled remainder of a GTC taker', () => {
    engine.handle(limit({ user: 'a', side: 'SELL', price: '100', quantity: '0.4' }));
    const events = engine.handle(limit({ user: 'b', side: 'BUY', price: '100', quantity: '1' }));

    expect(only(events, 'ORDER_DONE')).toHaveLength(1);
    expect(engine.depth(5)).toEqual({ bids: [[amt('100'), amt('0.6')]], asks: [] });
  });

  it('expires the remainder of an IOC taker', () => {
    engine.handle(limit({ user: 'a', side: 'SELL', price: '100', quantity: '0.4' }));
    const taker = limit({
      user: 'b',
      side: 'BUY',
      price: '100',
      quantity: '1',
      timeInForce: 'IOC',
    });

    const events = engine.handle(taker);

    expect(only(events, 'ORDER_DONE').at(-1)).toMatchObject({
      orderId: taker.orderId,
      status: 'EXPIRED',
      reason: 'IOC_REMAINDER',
    });
    expect(engine.depth(5)).toEqual({ bids: [], asks: [] });
  });

  it('sweeps levels with a market sell and expires on an empty book', () => {
    engine.handle(limit({ user: 'a', side: 'BUY', price: '100', quantity: '1' }));
    engine.handle(limit({ user: 'a', side: 'BUY', price: '99', quantity: '1' }));
    const taker = marketSell('b', '3');

    const events = engine.handle(taker);

    expect(only(events, 'TRADE').map((t) => t.price)).toEqual([amt('100'), amt('99')]);
    expect(only(events, 'ORDER_DONE').at(-1)).toMatchObject({
      orderId: taker.orderId,
      status: 'EXPIRED',
      reason: 'NO_LIQUIDITY',
    });
  });

  it('spends a market buy budget in whole lots and treats leftover dust as filled', () => {
    engine.handle(limit({ user: 'a', side: 'SELL', price: '100', quantity: '1' }));
    const taker = marketBuy('b', '50.00099');

    const events = engine.handle(taker);

    expect(only(events, 'TRADE').map((t) => t.quantity)).toEqual([amt('0.5')]);
    expect(only(events, 'ORDER_DONE').at(-1)).toMatchObject({ status: 'FILLED', reason: 'FILLED' });
  });

  it('expires a market buy that runs out of book', () => {
    engine.handle(limit({ user: 'a', side: 'SELL', price: '100', quantity: '0.1' }));
    const events = engine.handle(marketBuy('b', '50'));

    expect(only(events, 'TRADE').map((t) => t.quantity)).toEqual([amt('0.1')]);
    expect(only(events, 'ORDER_DONE').at(-1)).toMatchObject({
      status: 'EXPIRED',
      reason: 'NO_LIQUIDITY',
    });
  });

  it('expires the taker instead of trading with the same user', () => {
    engine.handle(limit({ user: 'x', side: 'SELL', price: '100', quantity: '1' }));
    const own = limit({ user: 'a', side: 'SELL', price: '101', quantity: '1' });
    engine.handle(own);
    const taker = limit({ user: 'a', side: 'BUY', price: '101', quantity: '2' });

    const events = engine.handle(taker);

    expect(only(events, 'TRADE')).toHaveLength(1);
    expect(only(events, 'ORDER_DONE').at(-1)).toMatchObject({
      orderId: taker.orderId,
      status: 'EXPIRED',
      reason: 'SELF_TRADE',
    });
    expect(engine.depth(5).asks).toEqual([[amt('101'), amt('1')]]);
  });

  it('caps fills per command and expires the rest instead of resting a crossing order', () => {
    const capped = new MatchingEngine(BTC, 3);
    for (let i = 0; i < 5; i++)
      capped.handle(limit({ user: `m${String(i)}`, side: 'SELL', price: '100', quantity: '1' }));
    const taker = limit({ user: 't', side: 'BUY', price: '100', quantity: '5' });

    const events = capped.handle(taker);

    expect(only(events, 'TRADE')).toHaveLength(3);
    expect(only(events, 'ORDER_DONE').at(-1)).toMatchObject({
      orderId: taker.orderId,
      status: 'EXPIRED',
      reason: 'FILL_LIMIT',
    });
    expect(capped.depth(5)).toEqual({ bids: [], asks: [[amt('100'), amt('2')]] });
  });

  it('expires a market buy whose budget cannot buy a single lot', () => {
    engine.handle(limit({ user: 'a', side: 'SELL', price: '100000', quantity: '1' }));
    const taker = marketBuy('b', '0.5');

    const events = engine.handle(taker);

    expect(only(events, 'TRADE')).toHaveLength(0);
    expect(only(events, 'ORDER_DONE')).toMatchObject([
      { status: 'EXPIRED', reason: 'NO_LIQUIDITY' },
    ]);
  });

  it('cancels a resting order for its owner only', () => {
    const order = limit({ user: 'a', side: 'BUY', price: '100', quantity: '1' });
    engine.handle(order);

    expect(kinds(engine.handle(cancel('mallory', order.orderId)))).toEqual(['CANCEL_REJECTED']);
    const events = engine.handle(cancel('a', order.orderId));

    expect(only(events, 'ORDER_DONE')).toMatchObject([
      { status: 'CANCELLED', reason: 'USER_CANCEL' },
    ]);
    expect(only(events, 'BOOK_LEVEL')).toMatchObject([{ side: 'BUY', quantity: 0n }]);
    expect(kinds(engine.handle(cancel('a', order.orderId)))).toEqual(['CANCEL_REJECTED']);
  });

  it('ignores a redelivered command', () => {
    const order = limit({ user: 'a', side: 'BUY', price: '100', quantity: '1' });
    engine.handle(order);

    expect(engine.handle(order)).toEqual([]);
    expect(engine.depth(5).bids).toEqual([[amt('100'), amt('1')]]);
  });

  it('refuses commands for another market', () => {
    const order = {
      ...limit({ user: 'a', side: 'BUY', price: '1', quantity: '1' }),
      symbol: 'ETH-USDT',
    };
    expect(() => engine.handle(order)).toThrow(/routed/);
  });
});
