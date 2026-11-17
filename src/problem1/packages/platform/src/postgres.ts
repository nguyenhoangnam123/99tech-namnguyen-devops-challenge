import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Logger } from './logger.js';

export { sql };
export type { Kysely, Transaction } from 'kysely';

export interface DatabaseOptions {
  readonly url: string;
  readonly poolSize: number;
  readonly applicationName: string;
  readonly statementTimeoutMs?: number;
}

export interface Database<DB> {
  readonly db: Kysely<DB>;
  readonly pool: pg.Pool;
  ping(): Promise<void>;
  close(): Promise<void>;
}

// Fail fast on a saturated pool instead of queueing requests forever.
export function createDatabase<DB>(options: DatabaseOptions, logger: Logger): Database<DB> {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolSize,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    application_name: options.applicationName,
    statement_timeout: options.statementTimeoutMs ?? 5_000,
  });
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle postgres client failed');
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    ping: async () => {
      await sql`select 1`.execute(db);
    },
    close: () => db.destroy(),
  };
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';
export const PG_SERIALIZATION_FAILURE = '40001';
export const PG_DEADLOCK = '40P01';

export function pgErrorCode(error: unknown): string | undefined {
  return error instanceof pg.DatabaseError ? error.code : undefined;
}

export function pgConstraint(error: unknown): string | undefined {
  return error instanceof pg.DatabaseError ? error.constraint : undefined;
}
