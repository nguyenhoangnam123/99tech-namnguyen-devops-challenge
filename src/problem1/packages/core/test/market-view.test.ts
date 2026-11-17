import { describe, expect, it } from 'vitest';
import { MatchingEngine } from '../src/matching/engine.js';
import { MarketView } from '../src/market-view.js';
import type { MatcherEvent, TradeEvent } from '../src/matching/messages.js';
import { BTC, amt, limit } from './fixtures.js';

const tradeAt = (executedAt: string, price: string, quantity: string, id: string): TradeEvent => ({
  kind: 'TRADE',
  eventId: id,
  symbol: 'BTC-USDT',
  price: amt(price),
  quantity: amt(quantity),
  takerSide: 'BUY',
  makerOrderId: 'm',
  makerUserId: 'a',
  takerOrderId: 't',
  takerUserId: 'b',
  executedAt,
});

describe('MarketView', () => {
  it('mirrors the engine book from its level events', () => {
    const engine = new MatchingEngine(BTC);
    const view = new MarketView(BTC);
    const commands = [
      limit({ user: 'a', side: 'BUY', price: '99', quantity: '1' }),
      limit({ user: 'a', side: 'BUY', price: '100', quantity: '2' }),
      limit({ user: 'b', side: 'SELL', price: '101', quantity: '1' }),
      limit({ user: 'c', side: 'SELL', price: '100', quantity: '0.5' }),
    ];
    const events: MatcherEvent[] = commands.flatMap((command) => engine.handle(command));
    events.forEach((event) => {
      view.apply(event);
    });

    expect(view.depth(10)).toEqual(engine.depth(10));
    expect(view.depth(1).bids).toEqual([[amt('100'), amt('1.5')]]);
  });

  it('lists recent trades newest first', () => {
    const view = new MarketView(BTC, 2);
    ['t1', 't2', 't3'].forEach((id) => {
      view.apply(tradeAt('2026-11-17T00:00:00Z', '100', '1', id));
    });

    expect(view.recentTrades(10).map((t) => t.tradeId)).toEqual(['t3', 't2']);
  });

  it('computes 24h stats from trades inside the window only', () => {
    const view = new MarketView(BTC);
    view.apply(tradeAt('2026-11-15T23:00:00Z', '50', '9', 'old'));
    view.apply(tradeAt('2026-11-16T12:00:00Z', '100', '1', 'a'));
    view.apply(tradeAt('2026-11-16T13:00:00Z', '120', '2', 'b'));
    view.apply(tradeAt('2026-11-17T09:00:00Z', '90', '1', 'c'));

    const stats = view.ticker(Date.parse('2026-11-17T10:00:00Z'));

    expect(stats).toEqual({
      lastPrice: amt('90'),
      open: amt('100'),
      high: amt('120'),
      low: amt('90'),
      volume: amt('4'),
      quoteVolume: amt('430'),
      tradeCount: 3,
    });
  });

  it('keeps the last price when the window is empty', () => {
    const view = new MarketView(BTC);
    view.apply(tradeAt('2026-11-10T00:00:00Z', '77', '1', 'x'));

    expect(view.ticker(Date.parse('2026-11-17T00:00:00Z'))).toMatchObject({
      lastPrice: amt('77'),
      open: null,
      volume: 0n,
      tradeCount: 0,
    });
  });
});
