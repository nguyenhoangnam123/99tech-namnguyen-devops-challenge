import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Logger } from './logger.js';

export type Kafka = KafkaJS.Kafka;
export type Producer = KafkaJS.Producer;
export type Consumer = KafkaJS.Consumer;
export type Admin = KafkaJS.Admin;
export type KafkaMessage = KafkaJS.KafkaMessage;
export type EachBatchPayload = KafkaJS.EachBatchPayload;

export function createKafka(brokers: string[], clientId: string, logger: Logger): Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: {
      brokers,
      clientId,
      logLevel: KafkaJS.logLevel.WARN,
      logger: kafkaLogger(logger.child({ component: 'kafka' })),
    },
  });
}

function kafkaLogger(logger: Logger): KafkaJS.Logger {
  const adapter: KafkaJS.Logger = {
    info: (message, extra) => {
      logger.info(extra, message);
    },
    error: (message, extra) => {
      logger.error(extra, message);
    },
    warn: (message, extra) => {
      logger.warn(extra, message);
    },
    debug: (message, extra) => {
      logger.debug(extra, message);
    },
    namespace: () => adapter,
    setLogLevel: () => undefined,
  };
  return adapter;
}

// acks=all with idempotence: no loss and no broker-side duplicates.
export function createProducer(kafka: Kafka, transactionalId?: string): Producer {
  return kafka.producer({
    'linger.ms': 1,
    kafkaJS: {
      acks: -1,
      idempotent: true,
      ...(transactionalId ? { transactionalId, maxInFlightRequests: 1 } : {}),
    },
  });
}

export interface ConsumerOptions {
  readonly groupId: string;
  readonly fromBeginning?: boolean;
}

// Offsets are committed by the caller after its side effects succeed.
export function createConsumer(kafka: Kafka, options: ConsumerOptions): Consumer {
  return kafka.consumer({
    'js.consumer.max.batch.size': 256,
    kafkaJS: {
      groupId: options.groupId,
      fromBeginning: options.fromBeginning ?? true,
      autoCommit: false,
      maxWaitTimeInMs: 50,
    },
  });
}

export interface PartitionOffsets {
  readonly partition: number;
  readonly low: bigint;
  readonly high: bigint;
}

// High is the last stable offset, so uncommitted transactions are excluded.
export async function stableOffsets(kafka: Kafka, topic: string): Promise<PartitionOffsets[]> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const offsets = await admin.fetchTopicOffsets(topic, {
      isolationLevel: KafkaJS.IsolationLevel.READ_COMMITTED,
    });
    return offsets.map(({ partition, low, high }) => ({
      partition,
      low: BigInt(low),
      high: BigInt(high),
    }));
  } finally {
    await admin.disconnect();
  }
}
