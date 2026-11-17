import type { DB } from '@exchange/contracts';
import type { Err, Result } from '@exchange/core';
import type { Kysely, Transaction } from '@exchange/platform';
import type { TransactionPorts, UnitOfWork } from '../../app/ports.js';
import { PgLedgerStore } from './ledger-store.js';
import {
  PgCommandOutbox,
  PgDepositStore,
  PgFillStore,
  PgInbox,
  PgOrderStore,
  PgUserStore,
} from './stores.js';

// Carries an error result out of the transaction callback to force a rollback.
class Rollback<E extends string> extends Error {
  constructor(readonly result: Err<E>) {
    super(`rollback: ${result.error}`);
  }
}

export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Kysely<DB>) {}

  async run<T, E extends string>(
    work: (tx: TransactionPorts) => Promise<Result<T, E>>,
  ): Promise<Result<T, E>> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const result = await work(portsFor(trx));
        if (!result.ok) throw new Rollback(result);
        return result;
      });
    } catch (error) {
      if (error instanceof Rollback) return error.result as Err<E>;
      throw error;
    }
  }

  execute<T>(work: (tx: TransactionPorts) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) => work(portsFor(trx)));
  }
}

function portsFor(trx: Transaction<DB>): TransactionPorts {
  return {
    users: new PgUserStore(trx),
    ledger: new PgLedgerStore(trx),
    orders: new PgOrderStore(trx),
    fills: new PgFillStore(trx),
    deposits: new PgDepositStore(trx),
    outbox: new PgCommandOutbox(trx),
    inbox: new PgInbox(trx),
  };
}
