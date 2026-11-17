import { decodeEventBatch } from '@exchange/codecs';
import { TOPICS } from '@exchange/contracts';
import {
  type Consumer,
  Counter,
  Histogram,
  LATENCY_BUCKETS,
  type Registry,
  carrierFromHeaders,
  withSpan,
} from '@exchange/platform';
import type { SettlementService } from '../../app/settlement.js';

// Offsets are committed only after settlement commits, so a crash
// redelivers and the inbox turns the redelivery into a no-op.
export class SettlementConsumer {
  private readonly applied: Counter;
  private readonly lag: Histogram;

  constructor(
    private readonly consumer: Consumer,
    private readonly settlement: SettlementService,
    private readonly onFatal: (error: unknown) => void,
    registry: Registry,
  ) {
    this.applied = new Counter({
      name: 'settlement_batches_total',
      help: 'Matcher event batches by outcome',
      labelNames: ['outcome'],
      registers: [registry],
    });
    this.lag = new Histogram({
      name: 'settlement_lag_seconds',
      help: 'Time from Kafka append to settlement commit',
      buckets: LATENCY_BUCKETS,
      registers: [registry],
    });
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: [TOPICS.matcherEvents] });
    await this.consumer.run({
      eachBatch: async ({ batch }) => {
        try {
          for (const message of batch.messages) {
            if (!message.value) continue;
            const events = decodeEventBatch(message.value);
            const outcome = await withSpan(
              'oms.settle',
              carrierFromHeaders(message.headers),
              () => this.settlement.apply(events),
              { 'exchange.symbol': events.symbol, 'exchange.command_id': events.commandId },
            );
            this.applied.inc({ outcome });
            this.lag.observe((Date.now() - Number(message.timestamp)) / 1000);
          }
          const last = batch.messages.at(-1);
          if (last) {
            await this.consumer.commitOffsets([
              {
                topic: batch.topic,
                partition: batch.partition,
                offset: String(BigInt(last.offset) + 1n),
              },
            ]);
          }
        } catch (error) {
          this.onFatal(error);
          throw error;
        }
      },
    });
  }

  stop(): Promise<void> {
    return this.consumer.disconnect();
  }
}
