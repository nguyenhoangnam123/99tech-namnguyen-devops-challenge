import type { Market } from '../markets.js';
import { type Amount, divDown, floorTo, minAmount, mulDown } from '../money.js';
import type { DoneReason, FinalStatus, Side } from '../orders.js';
import { InvariantViolation } from '../result.js';
import { BookSide, type RestingOrder } from './book-side.js';
import type { CancelCommand, MatcherCommand, MatcherEvent, PlaceCommand } from './messages.js';
import { RecentIds } from './recent-ids.js';

const DEFAULT_DEDUPE_WINDOW = 100_000;
// Bounds one command's event batch: a sweep of thousands of dust
// makers would otherwise exceed the Kafka message size and halt matching.
const DEFAULT_MAX_FILLS = 500;

// Price-time priority matching for one market. Pure and deterministic:
// the same command sequence always yields the same events and ids.
export class MatchingEngine {
  private readonly bids = new BookSide('BUY');
  private readonly asks = new BookSide('SELL');
  private readonly resting = new Map<string, RestingOrder>();
  private readonly recent: RecentIds;

  constructor(
    readonly market: Market,
    private readonly maxFills = DEFAULT_MAX_FILLS,
    dedupeWindow = DEFAULT_DEDUPE_WINDOW,
  ) {
    this.recent = new RecentIds(dedupeWindow);
  }

  handle(command: MatcherCommand): MatcherEvent[] {
    if (command.symbol !== this.market.symbol) {
      throw new InvariantViolation(`${command.symbol} routed to ${this.market.symbol} engine`);
    }
    if (!this.recent.add(command.commandId)) return [];
    const events = new EventBuffer(command, this);
    if (command.kind === 'PLACE') this.place(command, events);
    else this.cancel(command, events);
    return events.drain();
  }

  depth(limit: number): { bids: [Amount, Amount][]; asks: [Amount, Amount][] } {
    return { bids: this.bids.depth(limit), asks: this.asks.depth(limit) };
  }

  levelTotal(side: Side, price: Amount): Amount {
    return this.sideOf(side).levelTotal(price);
  }

  private place(command: PlaceCommand, events: EventBuffer): void {
    const taker = new Taker(command, this.market);
    const book = this.sideOf(opposite(command.spec.side));
    let stoppedBy: DoneReason | undefined;

    for (let level = book.best(); level && taker.accepts(level.price); level = book.best()) {
      const maker = level.orders[0];
      if (!maker) throw new InvariantViolation('Empty price level');
      if (maker.userId === command.userId) {
        stoppedBy = 'SELF_TRADE';
        break;
      }
      if (taker.fills === this.maxFills) {
        stoppedBy = 'FILL_LIMIT';
        break;
      }
      const quantity = taker.fillableAgainst(maker.remaining, level.price);
      if (quantity === 0n) break;

      book.fillBest(quantity);
      taker.fill(quantity, level.price);
      events.trade(maker, quantity, level.price);
      events.touch(book.side, level.price);
      if (maker.remaining === 0n) {
        this.resting.delete(maker.orderId);
        events.done(maker.orderId, maker.userId, 'FILLED', 'FILLED');
      }
      if (taker.isFilled()) break;
    }
    this.finishTaker(command, taker, stoppedBy, events);
  }

  private finishTaker(
    command: PlaceCommand,
    taker: Taker,
    stoppedBy: DoneReason | undefined,
    events: EventBuffer,
  ): void {
    const outcome = this.takerOutcome(command, taker, stoppedBy);
    if (outcome === 'REST') this.rest(command, taker, events);
    else events.done(command.orderId, command.userId, outcome.status, outcome.reason);
  }

  private takerOutcome(
    { spec }: PlaceCommand,
    taker: Taker,
    stoppedBy: DoneReason | undefined,
  ): 'REST' | Outcome {
    if (taker.isFilled()) return FILLED;
    if (stoppedBy) return { status: 'EXPIRED', reason: stoppedBy };
    if (spec.type === 'LIMIT') {
      return spec.timeInForce === 'GTC' ? 'REST' : { status: 'EXPIRED', reason: 'IOC_REMAINDER' };
    }
    const bestOpposite = this.sideOf(opposite(spec.side)).best()?.price;
    return taker.isBudgetSpent(bestOpposite) && taker.fills > 0
      ? FILLED
      : { status: 'EXPIRED', reason: 'NO_LIQUIDITY' };
  }

  private rest(command: PlaceCommand, taker: Taker, events: EventBuffer): void {
    if (command.spec.type !== 'LIMIT') throw new InvariantViolation('Only limit orders rest');
    const order: RestingOrder = {
      orderId: command.orderId,
      userId: command.userId,
      side: command.spec.side,
      price: command.spec.price,
      remaining: taker.remainingQuantity,
    };
    this.sideOf(command.spec.side).add(order);
    this.resting.set(order.orderId, order);
    events.touch(command.spec.side, order.price);
  }

  private cancel(command: CancelCommand, events: EventBuffer): void {
    const order = this.resting.get(command.orderId);
    if (order?.userId !== command.userId) {
      events.cancelRejected();
      return;
    }
    this.sideOf(order.side).remove(order);
    this.resting.delete(order.orderId);
    events.touch(order.side, order.price);
    events.done(order.orderId, order.userId, 'CANCELLED', 'USER_CANCEL');
  }

  private sideOf(side: Side): BookSide {
    return side === 'BUY' ? this.bids : this.asks;
  }
}

interface Outcome {
  readonly status: FinalStatus;
  readonly reason: DoneReason;
}

const FILLED: Outcome = { status: 'FILLED', reason: 'FILLED' };

const opposite = (side: Side): Side => (side === 'BUY' ? 'SELL' : 'BUY');

// Tracks what the incoming order may still take from the book.
class Taker {
  remainingQuantity: Amount;
  fills = 0;
  private remainingBudget: Amount;

  constructor(
    private readonly command: PlaceCommand,
    private readonly market: Market,
  ) {
    const { spec } = command;
    this.remainingQuantity = 'quantity' in spec ? spec.quantity : 0n;
    this.remainingBudget = 'quoteQuantity' in spec ? spec.quoteQuantity : 0n;
  }

  private get spendsBudget(): boolean {
    return 'quoteQuantity' in this.command.spec;
  }

  accepts(price: Amount): boolean {
    const { spec } = this.command;
    if (spec.type === 'MARKET') return true;
    return spec.side === 'BUY' ? price <= spec.price : price >= spec.price;
  }

  fillableAgainst(makerRemaining: Amount, price: Amount): Amount {
    if (!this.spendsBudget) return minAmount(makerRemaining, this.remainingQuantity);
    const affordable = floorTo(divDown(this.remainingBudget, price), this.market.lotSize);
    return minAmount(makerRemaining, affordable);
  }

  fill(quantity: Amount, price: Amount): void {
    this.fills += 1;
    if (this.spendsBudget) this.remainingBudget -= mulDown(price, quantity);
    else this.remainingQuantity -= quantity;
  }

  isFilled(): boolean {
    return !this.spendsBudget && this.remainingQuantity === 0n;
  }

  // A quote budget is spent once it cannot buy one lot at the best ask.
  isBudgetSpent(bestAsk: Amount | undefined): boolean {
    if (!this.spendsBudget) return false;
    if (this.remainingBudget === 0n) return true;
    return bestAsk !== undefined && mulDown(bestAsk, this.market.lotSize) > this.remainingBudget;
  }
}

// Collects one command's events, numbering them from the command id.
class EventBuffer {
  private readonly events: MatcherEvent[] = [];
  private readonly touched = new Map<string, { side: Side; price: Amount }>();

  constructor(
    private readonly command: MatcherCommand,
    private readonly engine: MatchingEngine,
  ) {}

  trade(maker: RestingOrder, quantity: Amount, price: Amount): void {
    const { command } = this;
    if (command.kind !== 'PLACE') throw new InvariantViolation('Only placements trade');
    this.events.push({
      kind: 'TRADE',
      eventId: this.nextId(),
      symbol: command.symbol,
      price,
      quantity,
      takerSide: command.spec.side,
      makerOrderId: maker.orderId,
      makerUserId: maker.userId,
      takerOrderId: command.orderId,
      takerUserId: command.userId,
      executedAt: command.issuedAt,
    });
  }

  done(orderId: string, userId: string, status: FinalStatus, reason: DoneReason): void {
    this.events.push({
      kind: 'ORDER_DONE',
      eventId: this.nextId(),
      symbol: this.command.symbol,
      orderId,
      userId,
      status,
      reason,
    });
  }

  cancelRejected(): void {
    const { command } = this;
    this.events.push({
      kind: 'CANCEL_REJECTED',
      eventId: this.nextId(),
      symbol: command.symbol,
      orderId: command.orderId,
      userId: command.userId,
    });
  }

  touch(side: Side, price: Amount): void {
    this.touched.set(`${side}:${price}`, { side, price });
  }

  // Book levels go last so they carry the final size per level.
  drain(): MatcherEvent[] {
    for (const { side, price } of this.touched.values()) {
      this.events.push({
        kind: 'BOOK_LEVEL',
        eventId: this.nextId(),
        symbol: this.command.symbol,
        side,
        price,
        quantity: this.engine.levelTotal(side, price),
      });
    }
    return this.events;
  }

  private nextId(): string {
    return `${this.command.commandId}:${this.events.length}`;
  }
}
