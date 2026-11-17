import { type Amount, parseAmount } from './money.js';

export const ASSETS = ['BTC', 'ETH', 'USDT'] as const;
export type Asset = (typeof ASSETS)[number];

export interface Market {
  readonly symbol: string;
  readonly base: Asset;
  readonly quote: Asset;
  readonly tickSize: Amount;
  readonly lotSize: Amount;
  readonly minNotional: Amount;
  readonly maxPrice: Amount;
  readonly maxQuantity: Amount;
  readonly makerFeeRate: Amount;
  readonly takerFeeRate: Amount;
}

type MarketDefinition = Record<Exclude<keyof Market, 'symbol' | 'base' | 'quote'>, string> &
  Pick<Market, 'symbol' | 'base' | 'quote'>;

function defineMarket(definition: MarketDefinition): Market {
  return {
    symbol: definition.symbol,
    base: definition.base,
    quote: definition.quote,
    tickSize: parseAmount(definition.tickSize),
    lotSize: parseAmount(definition.lotSize),
    minNotional: parseAmount(definition.minNotional),
    maxPrice: parseAmount(definition.maxPrice),
    maxQuantity: parseAmount(definition.maxQuantity),
    makerFeeRate: parseAmount(definition.makerFeeRate),
    takerFeeRate: parseAmount(definition.takerFeeRate),
  };
}

// tick × lot stays above 1e-18, so price × quantity is always exact.
export const MARKETS: readonly Market[] = [
  defineMarket({
    symbol: 'BTC-USDT',
    base: 'BTC',
    quote: 'USDT',
    tickSize: '0.01',
    lotSize: '0.00001',
    minNotional: '5',
    maxPrice: '10000000',
    maxQuantity: '1000',
    makerFeeRate: '0.001',
    takerFeeRate: '0.001',
  }),
  defineMarket({
    symbol: 'ETH-USDT',
    base: 'ETH',
    quote: 'USDT',
    tickSize: '0.01',
    lotSize: '0.0001',
    minNotional: '5',
    maxPrice: '1000000',
    maxQuantity: '10000',
    makerFeeRate: '0.001',
    takerFeeRate: '0.001',
  }),
];

const BY_SYMBOL = new Map(MARKETS.map((market) => [market.symbol, market]));

export function findMarket(symbol: string): Market | undefined {
  return BY_SYMBOL.get(symbol);
}

export function isAsset(value: string): value is Asset {
  return (ASSETS as readonly string[]).includes(value);
}
