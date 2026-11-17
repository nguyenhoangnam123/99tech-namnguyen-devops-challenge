import { randomUUID } from 'node:crypto';
import { decodeCommand, encodeEventBatch } from '@exchange/codecs';
import { TOPICS } from '@exchange/contracts';
import {
  type Admin,
  type Consumer,
  Counter,
  type EachBatchPayload,
  Histogram,
  type Kafka,
  LATENCY_BUCKETS,
  type Logger,
  type Producer,
  type Registry,
  createConsumer,
} from '@exchange/platform';
import type { Matcher } from '../../app/matcher.js';

export const MATCHER_GROUP = 'matcher';

type Offsets = Map<number, bigint>;

// Events and the command offset commit in one Kafka transaction, so
// "processed" means exactly "events published". On start, replaying
// commands up to the committed offset rebuilds the in-memory books.
export class MatcherWorker {
  private consumer: Consumer | undefined;
  private ready = false;
  private readonly commands: Counter;
  private readonly latency: Histogram;

  constructor(
    private readonly kafka: Kafka,
    private readonly producer: Producer,
    private readonly matcher: Matcher,
    private readonly onFatal: (error: unknown) => void,
    private readonly logger: Logger,
    registry: Registry,
  ) {
    this.commands = new Counter({
      name: 'matcher_commands_total',
      help: 'Commands applied to the books',
      labelNames: ['mode'],
      registers: [registry],
    });
    this.latency = new Histogram({
      name: 'matcher_command_age_seconds',
      help: 'Time from command issue to matcher commit',
      buckets: LATENCY_BUCKETS,
      registers: [registry],
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const committed = await committedOffsets(admin);
      await this.replay(committed);
    } finally {
      await admin.disconnect();
    }
    await this.consume();
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.consumer?.disconnect();
  }

  private async replay(committed: Offsets): Promise<void> {
    const pending = new Map([...committed].filter(([, offset]) => offset > 0n));
    if (pending.size === 0) return;
    this.logger.info({ partitions: Object.fromEntries(pending) }, 'replaying command log');
    const replayer = createConsumer(this.kafka, {
      groupId: `${MATCHER_GROUP}-replay-${randomUUID()}`,
    });
    await replayer.connect();
    await replayer.subscribe({ topics: [TOPICS.orderCommands] });
    await new Promise<void>((resolve, reject) => {
      replayer
        .run({
          eachBatch: async ({ batch }) => {
            const target = pending.get(batch.partition);
            for (const message of batch.messages) {
              if (target === undefined || BigInt(message.offset) >= target) break;
              if (message.value) this.matcher.handle(decodeCommand(message.value));
              this.commands.inc({ mode: 'replay' });
              if (BigInt(message.offset) + 1n >= target) pending.delete(batch.partition);
            }
            if (pending.size === 0) resolve();
            await Promise.resolve();
          },
        })
        .catch(reject);
    });
    await replayer.disconnect();
    this.logger.info('replay complete');
  }

  private async consume(): Promise<void> {
    const consumer = createConsumer(this.kafka, { groupId: MATCHER_GROUP });
    this.consumer = consumer;
    await consumer.connect();
    await consumer.subscribe({ topics: [TOPICS.orderCommands] });
    await consumer.run({ eachBatch: (payload) => this.process(consumer, payload) });
  }

  // Any failure aborts the transaction and stops the process: the books
  // already advanced in memory, so only a replay can make them consistent.
  private async process(consumer: Consumer, { batch }: EachBatchPayload): Promise<void> {
    const last = batch.messages.at(-1);
    if (!last) return;
    const transaction = await this.producer.transaction();
    try {
      const messages = batch.messages.flatMap((message) => {
        if (!message.value) return [];
        const command = decodeCommand(message.value);
        const events = this.matcher.handle(command);
        this.latency.observe((Date.now() - Date.parse(command.issuedAt)) / 1000);
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
      this.commands.inc({ mode: 'live' }, batch.messages.length);
    } catch (error) {
      await transaction.abort().catch(() => undefined);
      this.onFatal(error);
      throw error;
    }
  }
}

async function committedOffsets(admin: Admin): Promise<Offsets> {
  const [topic] = await admin.fetchOffsets({
    groupId: MATCHER_GROUP,
    topics: [TOPICS.orderCommands],
  });
  return new Map(
    (topic?.partitions ?? []).map(({ partition, offset }) => [partition, BigInt(offset)]),
  );
}
