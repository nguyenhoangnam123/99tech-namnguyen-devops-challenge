import { randomUUID } from 'node:crypto';
import { decodeCommand } from '@exchange/codecs';
import { TOPICS } from '@exchange/contracts';
import {
  type Admin,
  type Consumer,
  Counter,
  Histogram,
  type Kafka,
  type KafkaMessage,
  LATENCY_BUCKETS,
  type Logger,
  type Producer,
  type Registry,
  createConsumer,
} from '@exchange/platform';
import type { Matcher } from '../../app/matcher.js';
import { CommandBatchProcessor } from './batch-processor.js';

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
  private readonly processor: CommandBatchProcessor;

  constructor(
    private readonly kafka: Kafka,
    producer: Producer,
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
    this.processor = new CommandBatchProcessor(producer, matcher, {
      commandProcessed: (issuedAt) => {
        this.latency.observe((Date.now() - Date.parse(issuedAt)) / 1000);
      },
      batchCommitted: (size) => {
        this.commands.inc({ mode: 'live' }, size);
      },
    });
  }

  isReady(): boolean {
    return this.ready && !this.processor.halted;
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
    try {
      await new Promise<void>((resolve, reject) => {
        replayer
          .run({
            eachBatch: async ({ batch }) => {
              try {
                this.replayBatch(pending, batch.partition, batch.messages);
              } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
              }
              if (pending.size === 0) resolve();
              await Promise.resolve();
            },
          })
          .catch(reject);
      });
    } finally {
      await replayer.disconnect();
    }
    this.logger.info('replay complete');
  }

  // A replay failure must stop startup, not retry the same batch forever.
  private replayBatch(pending: Offsets, partition: number, messages: KafkaMessage[]): void {
    const target = pending.get(partition);
    for (const message of messages) {
      if (target === undefined || BigInt(message.offset) >= target) return;
      if (message.value) this.matcher.handle(decodeCommand(message.value));
      this.commands.inc({ mode: 'replay' });
      if (BigInt(message.offset) + 1n >= target) pending.delete(partition);
    }
  }

  private async consume(): Promise<void> {
    const consumer = createConsumer(this.kafka, {
      groupId: MATCHER_GROUP,
      instanceId: 'matcher-0',
    });
    this.consumer = consumer;
    await consumer.connect();
    await consumer.subscribe({ topics: [TOPICS.orderCommands] });
    await consumer.run({
      eachBatch: async (payload) => {
        try {
          await this.processor.process(consumer, payload);
        } catch (error) {
          this.onFatal(error);
          throw error;
        }
      },
    });
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
