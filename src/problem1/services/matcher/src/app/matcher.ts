import {
  InvariantViolation,
  MARKETS,
  type MatcherCommand,
  type MatcherEvent,
  MatchingEngine,
} from '@exchange/core';

// Routes each command to its market's engine. Pure: no clock, no IO,
// so replaying the command log rebuilds exactly the same books.
export class Matcher {
  private readonly engines = new Map(
    MARKETS.map((market) => [market.symbol, new MatchingEngine(market)]),
  );

  handle(command: MatcherCommand): MatcherEvent[] {
    const engine = this.engines.get(command.symbol);
    if (!engine) throw new InvariantViolation(`No engine for ${command.symbol}`);
    return engine.handle(command);
  }
}
