import {
  type Amount,
  type Asset,
  InvariantViolation,
  type Journal,
  type Result,
  depositJournal,
  err,
  ok,
} from '@exchange/core';
import type { Clock, DepositRecord, DepositStatus, TransactionPorts, UnitOfWork } from './ports.js';

export interface DepositNotice {
  readonly txId: string;
  readonly address: string;
  readonly asset: Asset;
  readonly amount: Amount;
}

export interface DepositReceipt {
  readonly txId: string;
  readonly status: DepositStatus;
  readonly duplicate: boolean;
}

export type DepositError = 'TX_ID_CONFLICT' | 'INVALID_AMOUNT';

// Exactly-once crediting: the provider's tx id is a primary key, so
// retried, late or concurrent deliveries all collapse onto one row.
export class DepositService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  record(notice: DepositNotice): Promise<Result<DepositReceipt, DepositError>> {
    if (notice.amount <= 0n) return Promise.resolve(err('INVALID_AMOUNT'));
    return this.uow.run<DepositReceipt, DepositError>(async (tx) => {
      const owner = await tx.deposits.addressOwner(notice.address);
      const matched = owner?.asset === notice.asset;
      const candidate: DepositRecord = {
        ...notice,
        userId: matched ? owner.userId : null,
        status: matched ? 'CREDITED' : 'UNMATCHED',
      };
      const { inserted, value: stored } = await tx.deposits.insertIfAbsent(
        candidate,
        this.clock.now(),
      );
      if (!inserted) {
        return isSameNotice(stored, notice)
          ? ok({ txId: stored.txId, status: stored.status, duplicate: true })
          : err('TX_ID_CONFLICT');
      }
      if (stored.userId !== null) {
        await postCredit(
          tx,
          depositJournal({
            txId: stored.txId,
            userId: stored.userId,
            asset: stored.asset,
            amount: stored.amount,
          }),
        );
      }
      return ok({ txId: stored.txId, status: stored.status, duplicate: false });
    });
  }
}

function isSameNotice(stored: DepositRecord, notice: DepositNotice): boolean {
  return (
    stored.address === notice.address &&
    stored.asset === notice.asset &&
    stored.amount === notice.amount
  );
}

// A credit only adds to a balance, so a refusal means the ledger is broken.
async function postCredit(tx: TransactionPorts, journal: Journal): Promise<void> {
  if ((await tx.ledger.post(journal)) !== 'POSTED') {
    throw new InvariantViolation(`Deposit ${journal.refId} was refused`);
  }
}
