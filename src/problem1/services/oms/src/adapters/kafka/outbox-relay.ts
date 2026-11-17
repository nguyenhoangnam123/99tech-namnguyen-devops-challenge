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

  // A session lock on one dedicated connection elects a single leader,
  // so no transaction stays open across the Kafka round trip.
  async run(): Promise<void> {
    const { signal } = this.stopping;
    await this.db.connection().execute(async (connection) => {
      while (!signal.aborted && !(await this.tryLead(connection))) await this.pause(1_000);
      let lastPrune = 0;
      while (!signal.aborted) {
        const sent = await this.publishBatch(connection);
        if (Date.now() - lastPrune > 60_000) {
          await this.prunePublished();
          lastPrune = Date.now();
        }
        if (sent === 0) await this.pause(this.options.idleWaitMs);
      }
    });
  }

  stop(): void {
    this.stopping.abort();
  }

  // Publish, then mark: a crash in between republishes, never drops.
  async publishBatch(connection: Kysely<DB>): Promise<number> {
    const batch = await connection
      .selectFrom('outbox')
      .select(['id', 'topic', 'message_key', 'payload', 'trace_parent'])
      .where('published_at', 'is', null)
      .orderBy('id')
      .limit(this.options.batchSize)
      .execute();
    if (batch.length === 0) return 0;
    await this.producer.sendBatch({
      topicMessages: [...groupBy(batch, (row) => row.topic)].map(([topic, rows]) => ({
        topic,
        messages: rows.map((row) => ({
          key: row.message_key,
          value: row.payload,
          headers: row.trace_parent ? { traceparent: row.trace_parent } : {},
        })),
      })),
    });
    await connection
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
  }

  private async tryLead(connection: Kysely<DB>): Promise<boolean> {
    const { rows } = await sql<{ locked: boolean }>`
      select pg_try_advisory_lock(${RELAY_LOCK_KEY}) as locked`.execute(connection);
    return rows[0]?.locked ?? false;
  }

  private pause(ms: number): Promise<void> {
    return sleep(ms, undefined, { signal: this.stopping.signal }).catch(() => undefined);
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
