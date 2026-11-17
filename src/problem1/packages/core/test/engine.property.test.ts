import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MatchingEngine } from '../src/matching/engine.js';
import type { MatcherCommand, MatcherEvent } from '../src/matching/messages.js';
import { mulDown } from '../src/money.js';
import { BTC, cancel, limit, marketBuy, marketSell } from './fixtures.js';

const USERS = ['u1', 'u2', 'u3'];

// Small price and size ranges force frequent crossing and partial fills.
const commandArb: fc.Arbitrary<(placed: string[]) => MatcherCommand> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .record({
        user: fc.constantFrom(...USERS),
        side: fc.constantFrom('BUY' as const, 'SELL' as const),
        ticks: fc.integer({ min: 9990, max: 10010 }),
        lots: fc.integer({ min: 1000, max: 20000 }),
        ioc: fc.boolean(),
      })
      .map(
        (a) => () =>
          limit({
            user: a.user,
            side: a.side,
            price: (a.ticks / 100).toFixed(2),
            quantity: (a.lots / 100000).toFixed(5),
            timeInForce: a.ioc ? 'IOC' : 'GTC',
          }),
      ),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ user: fc.constantFrom(...USERS), lots: fc.integer({ min: 1000, max: 30000 }) })
      .map((a) => () => marketSell(a.user, (a.lots / 100000).toFixed(5))),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ user: fc.constantFrom(...USERS), quote: fc.integer({ min: 5, max: 40 }) })
      .map((a) => () => marketBuy(a.user, String(a.quote))),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({ user: fc.constantFrom(...USERS), pick: fc.nat() })
      .map(
        (a) => (placed: string[]) =>
          cancel(a.user, placed[a.pick % Math.max(placed.length, 1)] ?? 'none'),
      ),
  },
);

// Totals per order, asserting no order trades after it was closed.
function tally(events: MatcherEvent[]): {
  filled: Map<string, bigint>;
  spent: Map<string, bigint>;
} {
  const filled = new Map<string, bigint>();
  const spent = new Map<string, bigint>();
  const closed = new Set<string>();
  for (const event of events) {
    if (event.kind === 'TRADE') {
      for (const id of [event.makerOrderId, event.takerOrderId]) {
        expect(closed.has(id)).toBe(false);
        filled.set(id, (filled.get(id) ?? 0n) + event.quantity);
      }
      spent.set(
        event.takerOrderId,
        (spent.get(event.takerOrderId) ?? 0n) + mulDown(event.price, event.quantity),
      );
    }
    if (event.kind === 'ORDER_DONE') {
      expect(closed.has(event.orderId)).toBe(false);
      closed.add(event.orderId);
    }
  }
  return { filled, spent };
}

function buildCommands(factories: ((placed: string[]) => MatcherCommand)[]): MatcherCommand[] {
  const placed: string[] = [];
  return factories.map((make) => {
    const command = make(placed);
    if (command.kind === 'PLACE') placed.push(command.orderId);
    return command;
  });
}

const runAll = (commands: MatcherCommand[]): { engine: MatchingEngine; events: MatcherEvent[] } => {
  const engine = new MatchingEngine(BTC);
  return { engine, events: commands.flatMap((command) => engine.handle(command)) };
};

describe('MatchingEngine properties', () => {
  const sequences = fc.array(commandArb, { minLength: 1, maxLength: 120 }).map(buildCommands);

  it('is deterministic: identical input gives identical events', () => {
    fc.assert(
      fc.property(sequences, (commands) => {
        expect(runAll(commands).events).toEqual(runAll(commands).events);
      }),
    );
  });

  it('never leaves the book crossed', () => {
    fc.assert(
      fc.property(sequences, (commands) => {
        const engine = new MatchingEngine(BTC);
        for (const command of commands) {
          engine.handle(command);
          const { bids, asks } = engine.depth(1);
          const bestBid = bids[0]?.[0];
          const bestAsk = asks[0]?.[0];
          if (bestBid !== undefined && bestAsk !== undefined) expect(bestBid < bestAsk).toBe(true);
        }
      }),
    );
  });

  it('never fills an order beyond its size or budget, and closes each order once', () => {
    fc.assert(
      fc.property(sequences, (commands) => {
        const { filled, spent } = tally(runAll(commands).events);
        for (const command of commands) {
          if (command.kind !== 'PLACE') continue;
          const { spec, orderId } = command;
          if ('quantity' in spec)
            expect(filled.get(orderId) ?? 0n).toBeLessThanOrEqual(spec.quantity);
          if ('quoteQuantity' in spec)
            expect(spent.get(orderId) ?? 0n).toBeLessThanOrEqual(spec.quoteQuantity);
        }
      }),
    );
  });

  it('publishes level sizes that match the book', () => {
    fc.assert(
      fc.property(sequences, (commands) => {
        const { engine, events } = runAll(commands);
        const levels = new Map<string, bigint>();
        for (const event of events) {
          if (event.kind === 'BOOK_LEVEL')
            levels.set(`${event.side}:${event.price}`, event.quantity);
        }
        const { bids, asks } = engine.depth(Number.MAX_SAFE_INTEGER);
        const live = [
          ...bids.map(([p, q]) => [`BUY:${p}`, q] as const),
          ...asks.map(([p, q]) => [`SELL:${p}`, q] as const),
        ];
        expect(new Map([...levels].filter(([, q]) => q > 0n))).toEqual(new Map(live));
      }),
    );
  });

  it('never trades a user with themselves', () => {
    fc.assert(
      fc.property(sequences, (commands) => {
        for (const event of runAll(commands).events) {
          if (event.kind === 'TRADE') expect(event.makerUserId).not.toBe(event.takerUserId);
        }
      }),
    );
  });
});
