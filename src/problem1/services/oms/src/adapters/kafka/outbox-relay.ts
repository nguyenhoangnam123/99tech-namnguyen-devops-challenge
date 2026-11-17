import { setTimeout as sleep } from 'node:timers/promises';
import type { DB } from '@exchange/contracts';
import {
  Counter,
  Gauge,
  type Kysely,
  type Logger,
  type Producer,
  type Registry,
  sql,
} from '@exchange/platform';

// One active relay at a time publishes in outbox id order; two relays
// could interleave batches and reorder commands for the same symbol.
const RELAY_LOCK_KEY = 4_242_001;
const RETENTION = '1 hour';

export interface RelayOptions {
  readonly batchSize: number;
  readonly idleWaitMs: number;
}

export class OutboxRelay {
  private readonly stopping = new AbortController();
  private readonly published: Counter;
  private readonly backlog: Gauge;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly producer: Producer,
    private readonly options: RelayOptions,
    private readonly logger: Logger,
    registry: Registry,
  ) {
    this.published = new Counter({
      name: 'outbox_published_total',
      help: 'Outbox rows published to Kafka',
      registers: [registry],
    });
    this.backlog = new Gauge({
      name: 'outbox_backlog',
      help: 'Unpublished outbox rows',
      registers: [registry],
      collect: async () => {
        const row = await this.db
          .selectFrom('outbox')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('published_at', 'is', null)
          .executeTakeFirstOrThrow();
        this.backlog.set(Number(row.count));
      },
    });
  }

  async run(): Promise<void> {
    const { signal } = this.stopping;
    let lastPrune = 0;
    while (!signal.aborted) {
      const sent = await this.publishBatch();
      if (Date.now() - lastPrune > 60_000) {
        await this.prunePublished();
        lastPrune = Date.now();
      }
      if (sent === 0)
        await sleep(this.options.idleWaitMs, undefined, { signal }).catch(() => undefined);
    }
  }

  stop(): void {
    this.stopping.abort();
  }

  // Publish then mark, in one transaction: a crash republishes, never drops.
  async publishBatch(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const { rows } = await sql<{
        locked: boolean;
      }>`select pg_try_advisory_xact_lock(${RELAY_LOCK_KEY}) as locked`.execute(trx);
      if (!rows[0]?.locked) return 0;
      const batch = await trx
        .selectFrom('outbox')
        .select(['id', 'topic', 'message_key', 'payload'])
        .where('published_at', 'is', null)
        .orderBy('id')
        .limit(this.options.batchSize)
        .execute();
      if (batch.length === 0) return 0;
      await this.producer.sendBatch({
        topicMessages: [...groupBy(batch, (row) => row.topic)].map(([topic, rowsForTopic]) => ({
          topic,
          messages: rowsForTopic.map((row) => ({ key: row.message_key, value: row.payload })),
        })),
      });
      await trx
        .updateTable('outbox')
        .set({ published_at: new Date() })
        .where(
          'id',
          'in',
          batch.map((row) => row.id),
        )
        .execute();
      this.published.inc(batch.length);
      return batch.length;
    });
  }

  private async prunePublished(): Promise<void> {
    const result = await sql`
      delete from outbox where published_at < now() - ${RETENTION}::interval`.execute(this.db);
    if (result.numAffectedRows)
      this.logger.debug({ pruned: Number(result.numAffectedRows) }, 'outbox pruned');
  }
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
}
