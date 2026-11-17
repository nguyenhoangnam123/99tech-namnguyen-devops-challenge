import type { Market } from './markets.js';
import type { BookLevelEvent, MatcherEvent, TradeEvent } from './matching/messages.js';
import { type Amount, mulDown } from './money.js';
import type { Side } from './orders.js';

export interface PublicTrade {
  readonly tradeId: string;
  readonly price: Amount;
  readonly quantity: Amount;
  readonly takerSide: Side;
  readonly executedAt: string;
}

export interface TickerStats {
  readonly lastPrice: Amount | null;
  readonly open: Amount | null;
  readonly high: Amount | null;
  readonly low: Amount | null;
  readonly volume: Amount;
  readonly quoteVolume: Amount;
  readonly tradeCount: number;
}

export type Level = readonly [price: Amount, quantity: Amount];

interface MinuteBucket {
  readonly minute: number;
  readonly open: Amount;
  high: Amount;
  low: Amount;
  volume: Amount;
  quoteVolume: Amount;
  count: number;
}

const MINUTE_MS = 60_000;
const WINDOW_MINUTES = 24 * 60;

// Read model for one market, rebuilt by replaying matcher events.
// Ticker stats use minute buckets so queries stay O(1440).
export class MarketView {
  private readonly bids = new Map<Amount, Amount>();
  private readonly asks = new Map<Amount, Amount>();
  private readonly trades: PublicTrade[] = [];
  private readonly buckets = new Map<number, MinuteBucket>();
  private lastPrice: Amount | null = null;

  constructor(
    readonly market: Market,
    private readonly tradeHistory = 100,
  ) {}

  apply(event: MatcherEvent): void {
    if (event.kind === 'BOOK_LEVEL') this.applyLevel(event);
    if (event.kind === 'TRADE') this.applyTrade(event);
  }

  depth(limit: number): { bids: Level[]; asks: Level[] } {
    return {
      bids: sortedLevels(this.bids, (a, b) => (a > b ? -1 : 1)).slice(0, limit),
      asks: sortedLevels(this.asks, (a, b) => (a < b ? -1 : 1)).slice(0, limit),
    };
  }

  recentTrades(limit: number): PublicTrade[] {
    return this.trades.slice(-limit).reverse();
  }

  ticker(nowMs: number): TickerStats {
    const since = minuteOf(nowMs) - WINDOW_MINUTES;
    const window = [...this.buckets.values()]
      .filter((bucket) => bucket.minute > since)
      .sort((a, b) => a.minute - b.minute);
    const first = window[0];
    if (!first) return emptyTicker(this.lastPrice);
    return window.reduce<TickerStats>(
      (stats, bucket) => ({
        ...stats,
        high: bucket.high > (stats.high ?? 0n) ? bucket.high : stats.high,
        low: stats.low === null || bucket.low < stats.low ? bucket.low : stats.low,
        volume: stats.volume + bucket.volume,
        quoteVolume: stats.quoteVolume + bucket.quoteVolume,
        tradeCount: stats.tradeCount + bucket.count,
      }),
      { ...emptyTicker(this.lastPrice), open: first.open, high: null, low: null },
    );
  }

  private applyLevel(event: BookLevelEvent): void {
    const levels = event.side === 'BUY' ? this.bids : this.asks;
    if (event.quantity === 0n) levels.delete(event.price);
    else levels.set(event.price, event.quantity);
  }

  private applyTrade(event: TradeEvent): void {
    this.trades.push(publicTradeOf(event));
    if (this.trades.length > this.tradeHistory) this.trades.shift();
    this.lastPrice = event.price;
    this.addToBucket(event);
  }

  private addToBucket(event: TradeEvent): void {
    const minute = minuteOf(Date.parse(event.executedAt));
    const quote = mulDown(event.price, event.quantity);
    const bucket = this.buckets.get(minute);
    if (bucket) {
      if (event.price > bucket.high) bucket.high = event.price;
      if (event.price < bucket.low) bucket.low = event.price;
      bucket.volume += event.quantity;
      bucket.quoteVolume += quote;
      bucket.count += 1;
    } else {
      this.buckets.set(minute, {
        minute,
        open: event.price,
        high: event.price,
        low: event.price,
        volume: event.quantity,
        quoteVolume: quote,
        count: 1,
      });
      this.pruneBefore(minute - WINDOW_MINUTES);
    }
  }

  private pruneBefore(minute: number): void {
    for (const key of this.buckets.keys()) {
      if (key <= minute) this.buckets.delete(key);
    }
  }
}

export const publicTradeOf = (event: TradeEvent): PublicTrade => ({
  tradeId: event.eventId,
  price: event.price,
  quantity: event.quantity,
  takerSide: event.takerSide,
  executedAt: event.executedAt,
});

const minuteOf = (epochMs: number): number => Math.floor(epochMs / MINUTE_MS);

function sortedLevels(
  levels: Map<Amount, Amount>,
  compare: (a: Amount, b: Amount) => number,
): Level[] {
  return [...levels.entries()].sort(([a], [b]) => compare(a, b));
}

function emptyTicker(lastPrice: Amount | null): TickerStats {
  return {
    lastPrice,
    open: null,
    high: null,
    low: null,
    volume: 0n,
    quoteVolume: 0n,
    tradeCount: 0,
  };
}
