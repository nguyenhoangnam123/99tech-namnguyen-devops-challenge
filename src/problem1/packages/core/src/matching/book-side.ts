import type { Amount } from '../money.js';
import { InvariantViolation } from '../result.js';
import type { Side } from '../orders.js';

export interface RestingOrder {
  readonly orderId: string;
  readonly userId: string;
  readonly side: Side;
  readonly price: Amount;
  remaining: Amount;
}

export interface PriceLevel {
  readonly price: Amount;
  readonly orders: RestingOrder[];
  total: Amount;
}

// One side of the book: levels best-first, orders FIFO within a level.
export class BookSide {
  private readonly levels: PriceLevel[] = [];

  constructor(readonly side: Side) {}

  best(): PriceLevel | undefined {
    return this.levels[0];
  }

  levelTotal(price: Amount): Amount {
    return this.levels.find((level) => level.price === price)?.total ?? 0n;
  }

  add(order: RestingOrder): void {
    const index = this.insertionIndex(order.price);
    let level = this.levels[index];
    if (level?.price !== order.price) {
      level = { price: order.price, orders: [], total: 0n };
      this.levels.splice(index, 0, level);
    }
    level.orders.push(order);
    level.total += order.remaining;
  }

  remove(order: RestingOrder): void {
    const index = this.levels.findIndex((level) => level.price === order.price);
    const level = this.levels[index];
    const position = level?.orders.indexOf(order) ?? -1;
    if (!level || position < 0)
      throw new InvariantViolation(`Order ${order.orderId} is not resting`);
    level.orders.splice(position, 1);
    level.total -= order.remaining;
    if (level.orders.length === 0) this.levels.splice(index, 1);
  }

  /** Fills the head order of the best level by `quantity`. */
  fillBest(quantity: Amount): RestingOrder {
    const level = this.levels[0];
    const maker = level?.orders[0];
    if (!level || !maker || quantity > maker.remaining) {
      throw new InvariantViolation('Fill exceeds the best resting order');
    }
    maker.remaining -= quantity;
    level.total -= quantity;
    if (maker.remaining === 0n) level.orders.shift();
    if (level.orders.length === 0) this.levels.shift();
    return maker;
  }

  depth(limit: number): [Amount, Amount][] {
    return this.levels.slice(0, limit).map((level) => [level.price, level.total]);
  }

  private insertionIndex(price: Amount): number {
    let low = 0;
    let high = this.levels.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const candidate = this.levels[middle];
      if (candidate && this.ranksBefore(candidate.price, price)) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private ranksBefore(a: Amount, b: Amount): boolean {
    return this.side === 'BUY' ? a > b : a < b;
  }
}
