import type { MarketDataApi } from '@exchange/contracts';
import { InvariantViolation, MARKETS, type MarketView } from '@exchange/core';
import { type OperationHandlers, problem } from '@exchange/platform';
import type { MarketData } from '../../app/market-data.js';
import { toDepthDto, toMarketDto, toSymbol, toTickerDto, toTradeDto } from '../dto.js';

export interface HttpDeps {
  readonly marketData: MarketData;
  readonly isCaughtUp: () => boolean;
  readonly now: () => number;
}

export function marketDataHandlers(deps: HttpDeps): OperationHandlers<MarketDataApi.operations> {
  const viewOf = (symbol: string): MarketView => {
    const view = deps.marketData.view(symbol);
    if (!view) throw new InvariantViolation(`No view for ${symbol}`);
    return view;
  };
  // Serving a half-replayed book would show prices that never existed.
  const replaying = () => problem(503, 'REPLAYING', 'market data is catching up');
  return {
    listMarkets: () =>
      Promise.resolve({ status: 200, body: { markets: MARKETS.map(toMarketDto) } }),

    getDepth: ({ path, query }) =>
      Promise.resolve(
        deps.isCaughtUp()
          ? { status: 200, body: toDepthDto(viewOf(path.symbol), query.limit ?? 20) }
          : replaying(),
      ),

    getRecentTrades: ({ path, query }) =>
      Promise.resolve(
        deps.isCaughtUp()
          ? {
              status: 200,
              body: {
                symbol: toSymbol(path.symbol),
                trades: viewOf(path.symbol)
                  .recentTrades(query.limit ?? 50)
                  .map(toTradeDto),
              },
            }
          : replaying(),
      ),

    getTicker: ({ path }) =>
      Promise.resolve(
        deps.isCaughtUp()
          ? { status: 200, body: toTickerDto(viewOf(path.symbol), deps.now()) }
          : replaying(),
      ),

    liveness: () => Promise.resolve({ status: 200, body: { status: 'ok' } }),

    readiness: () => {
      const caughtUp = deps.isCaughtUp();
      const body = {
        status: caughtUp ? ('ok' as const) : ('unavailable' as const),
        checks: { eventLog: caughtUp ? ('ok' as const) : ('failed' as const) },
      };
      return Promise.resolve(caughtUp ? { status: 200, body } : { status: 503, body });
    },
  };
}
