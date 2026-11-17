import { decodeCommand, encodeEventBatch } from '@exchange/codecs';
import { TOPICS } from '@exchange/contracts';
import {
  type Consumer,
  type EachBatchPayload,
  type OpenSpan,
  type Producer,
  carrierFromHeaders,
  startSpan,
} from '@exchange/platform';
import type { Matcher } from '../../app/matcher.js';

export interface BatchObserver {
  commandProcessed(issuedAt: string): void;
  batchCommitted(size: number): void;
}

// Events and offsets commit in one Kafka transaction. Books change in
// memory first, so after any failure this refuses all further work:
// only a restart and replay can realign memory with the log.
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
    const spans: OpenSpan[] = [];
    try {
      const messages = batch.messages.flatMap((message) => {
        if (!message.value) return [];
        const command = decodeCommand(message.value);
        const span = startSpan('matcher.match', carrierFromHeaders(message.headers), {
          'exchange.symbol': command.symbol,
          'exchange.command': command.kind,
        });
        spans.push(span);
        const events = this.matcher.handle(command);
        this.observer.commandProcessed(command.issuedAt);
        if (events.length === 0) return [];
        const value = Buffer.from(
          encodeEventBatch({ commandId: command.commandId, symbol: command.symbol, events }),
        );
        return [{ key: command.symbol, value, partition: batch.partition, headers: span.carrier }];
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
      spans.forEach((span) => {
        span.end();
      });
    } catch (error) {
      spans.forEach((span) => {
        span.end(error);
      });
      this.failure = error;
      consumer.pause([{ topic: batch.topic }]);
      await transaction.abort().catch(() => undefined);
      throw error;
    }
  }
}
