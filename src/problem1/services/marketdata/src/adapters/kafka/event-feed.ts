import { randomUUID } from 'node:crypto';
import { decodeEventBatch } from '@exchange/codecs';
import { TOPICS } from '@exchange/contracts';
import {
  type Consumer,
  Counter,
  type Kafka,
  type Registry,
  createConsumer,
  stableOffsets,
} from '@exchange/platform';
import type { MarketData } from '../../app/market-data.js';

const IDLE_CAUGHT_UP_MS = 3_000;

// Each instance rebuilds its read model from the start of the log and
// never commits offsets, so instances share nothing and scale freely.
export class EventFeed {
  private consumer: Consumer | undefined;
  private readonly lastApplied = new Map<number, bigint>();
  private readonly pending = new Map<number, bigint>();
  private caughtUp = false;
  private lastProgressAt = Date.now();
  private idleCheck: NodeJS.Timeout | undefined;
  private readonly applied: Counter;

  constructor(
    private readonly kafka: Kafka,
    private readonly marketData: MarketData,
    private readonly onFatal: (error: unknown) => void,
    registry: Registry,
  ) {
    this.applied = new Counter({
      name: 'marketdata_batches_total',
      help: 'Matcher event batches applied to the read model',
      registers: [registry],
    });
  }

  isCaughtUp(): boolean {
    return this.caughtUp;
  }

  async start(): Promise<void> {
    await this.recordStartTargets();
    const consumer = createConsumer(this.kafka, { groupId: `marketdata-${randomUUID()}` });
    this.consumer = consumer;
    await consumer.connect();
    await consumer.subscribe({ topics: [TOPICS.matcherEvents] });
    await consumer.run({
      eachBatch: async ({ batch }) => {
        try {
          for (const message of batch.messages) {
            const offset = BigInt(message.offset);
            if (offset <= (this.lastApplied.get(batch.partition) ?? -1n) || !message.value)
              continue;
            const { symbol, events } = decodeEventBatch(message.value);
            this.marketData.apply(symbol, events);
            this.lastApplied.set(batch.partition, offset);
            this.applied.inc();
            this.markProgress(batch.partition, offset);
          }
          this.lastProgressAt = Date.now();
          await Promise.resolve();
        } catch (error) {
          this.onFatal(error);
          throw error;
        }
      },
    });
    this.idleCheck = setInterval(() => {
      this.markIdle();
    }, 500);
  }

  stop(): Promise<void> {
    clearInterval(this.idleCheck);
    return this.consumer?.disconnect() ?? Promise.resolve();
  }

  // The last stable offset sits past a commit marker, which is never delivered.
  private async recordStartTargets(): Promise<void> {
    for (const { partition, low, high } of await stableOffsets(this.kafka, TOPICS.matcherEvents)) {
      if (high > low) this.pending.set(partition, high);
    }
    this.caughtUp = this.pending.size === 0;
  }

  // A log ending in an aborted transaction never reaches the target,
  // so a feed that has been quiet for a while counts as caught up.
  private markIdle(): void {
    if (!this.caughtUp && Date.now() - this.lastProgressAt > IDLE_CAUGHT_UP_MS)
      this.caughtUp = true;
  }

  private markProgress(partition: number, offset: bigint): void {
    const target = this.pending.get(partition);
    if (target !== undefined && offset + 2n >= target) this.pending.delete(partition);
    if (!this.caughtUp && this.pending.size === 0) this.caughtUp = true;
  }
}
