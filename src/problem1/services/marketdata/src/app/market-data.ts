import {
  MARKETS,
  MarketView,
  type MatcherEvent,
  type PublicTrade,
  publicTradeOf,
} from '@exchange/core';

export interface PendingUpdates {
  readonly depth: readonly string[];
  readonly trades: ReadonlyMap<string, readonly PublicTrade[]>;
}

// Read models for every market, plus what changed since the last drain.
export class MarketData {
  private readonly views = new Map(
    MARKETS.map((market) => [market.symbol, new MarketView(market)]),
  );
  private changedDepth = new Set<string>();
  private newTrades = new Map<string, PublicTrade[]>();

  view(symbol: string): MarketView | undefined {
    return this.views.get(symbol);
  }

  apply(symbol: string, events: readonly MatcherEvent[]): void {
    const view = this.views.get(symbol);
    if (!view) return;
    for (const event of events) {
      view.apply(event);
      if (event.kind === 'BOOK_LEVEL') this.changedDepth.add(symbol);
      if (event.kind === 'TRADE') {
        this.newTrades.set(symbol, [...(this.newTrades.get(symbol) ?? []), publicTradeOf(event)]);
      }
    }
  }

  drain(): PendingUpdates {
    const updates = { depth: [...this.changedDepth], trades: this.newTrades };
    this.changedDepth = new Set();
    this.newTrades = new Map();
    return updates;
  }
}
