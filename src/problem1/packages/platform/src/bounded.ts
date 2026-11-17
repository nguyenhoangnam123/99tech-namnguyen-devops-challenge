import { OverloadedError } from './http.js';

// Caps concurrent CPU-heavy work and sheds the excess immediately,
// so a burst cannot starve the event loop serving other requests.
export class Bounded {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxQueued) throw new OverloadedError('work queue is full');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running += 1;
    try {
      return await work();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }
}
