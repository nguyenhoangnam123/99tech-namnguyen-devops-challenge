import type { MarketDataApi } from '@exchange/contracts';
import {
  InvariantViolation,
  type Level,
  type Market,
  type MarketView,
  type PublicTrade,
  formatAmount,
} from '@exchange/core';

type Schemas = MarketDataApi.components['schemas'];

const SYMBOLS = ['BTC-USDT', 'ETH-USDT'] as const satisfies readonly Schemas['Symbol'][];

export function toSymbol(symbol: string): Schemas['Symbol'] {
  const known = SYMBOLS.find((candidate) => candidate === symbol);
  if (!known) throw new InvariantViolation(`Unknown symbol ${symbol}`);
  return known;
}

const nullableAmount = (amount: bigint | null): string | null =>
  amount === null ? null : formatAmount(amount);

const toLevels = (levels: Level[]): Schemas['Level'][] =>
  levels.map(([price, quantity]) => [formatAmount(price), formatAmount(quantity)]);

export function toMarketDto(market: Market): Schemas['Market'] {
  return {
    symbol: toSymbol(market.symbol),
    base: market.base,
    quote: market.quote,
    tickSize: formatAmount(market.tickSize),
    lotSize: formatAmount(market.lotSize),
    minNotional: formatAmount(market.minNotional),
    makerFeeRate: formatAmount(market.makerFeeRate),
    takerFeeRate: formatAmount(market.takerFeeRate),
  };
}

export function toDepthDto(view: MarketView, limit: number): Schemas['Depth'] {
  const { bids, asks } = view.depth(limit);
  return { symbol: toSymbol(view.market.symbol), bids: toLevels(bids), asks: toLevels(asks) };
}

export function toTradeDto(trade: PublicTrade): Schemas['PublicTrade'] {
  return {
    tradeId: trade.tradeId,
    price: formatAmount(trade.price),
    quantity: formatAmount(trade.quantity),
    takerSide: trade.takerSide,
    executedAt: trade.executedAt,
  };
}

export function toTickerDto(view: MarketView, nowMs: number): Schemas['Ticker'] {
  const stats = view.ticker(nowMs);
  return {
    symbol: toSymbol(view.market.symbol),
    lastPrice: nullableAmount(stats.lastPrice),
    open: nullableAmount(stats.open),
    high: nullableAmount(stats.high),
    low: nullableAmount(stats.low),
    volume: formatAmount(stats.volume),
    quoteVolume: formatAmount(stats.quoteVolume),
    tradeCount: stats.tradeCount,
  };
}
