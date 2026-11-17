import { decodeCommand, encodeEventBatch } from '@exchange/codecs';
import { TOPICS } from '@exchange/contracts';
import type { Consumer, EachBatchPayload, Producer } from '@exchange/platform';
import type { Matcher } from '../../app/matcher.js';

export interface BatchObserver {
  commandProcessed(issuedAt: string): void;
  batchCommitted(size: number): void;
}

// Events and consumed offsets commit in one Kafka transaction.
// The books change in memory before that commit, so after any failure
// this processor refuses all further work: only a restart and replay
// can make memory match the log again.
export class CommandBatchProcessor {
  private failure: unknown;

  constructor(
    private readonly producer: Producer,
    private readonly matcher: Matcher,
    private readonly observer: BatchObserver,
  ) {}

  get halted(): boolean {
    return this.failure !== undefined;
  }

  async process(consumer: Consumer, { batch }: EachBatchPayload): Promise<void> {
    if (this.halted)
      throw new Error('matcher halted after a failed batch', { cause: this.failure });
    const last = batch.messages.at(-1);
    if (!last) return;
    const transaction = await this.producer.transaction();
    try {
      const messages = batch.messages.flatMap((message) => {
        if (!message.value) return [];
        const command = decodeCommand(message.value);
        const events = this.matcher.handle(command);
        this.observer.commandProcessed(command.issuedAt);
        if (events.length === 0) return [];
        const value = Buffer.from(
          encodeEventBatch({ commandId: command.commandId, symbol: command.symbol, events }),
        );
        return [{ key: command.symbol, value, partition: batch.partition }];
      });
      if (messages.length > 0) await transaction.send({ topic: TOPICS.matcherEvents, messages });
      await transaction.sendOffsets({
        consumer,
        topics: [
          {
            topic: batch.topic,
            partitions: [{ partition: batch.partition, offset: String(BigInt(last.offset) + 1n) }],
          },
        ],
      });
      await transaction.commit();
      this.observer.batchCommitted(batch.messages.length);
    } catch (error) {
      this.failure = error;
      consumer.pause([{ topic: batch.topic }]);
      await transaction.abort().catch(() => undefined);
      throw error;
    }
  }
}
