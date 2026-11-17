import { randomUUID } from 'node:crypto';
import type { DB } from '@exchange/contracts';
import {
  ASSETS,
  type AccountRef,
  InvariantViolation,
  type Journal,
  formatAmount,
} from '@exchange/core';
import { pgConstraint, sql, type Transaction } from '@exchange/platform';
import type { LedgerStore } from '../../app/ports.js';

const EXCHANGE_OWNER = '00000000-0000-0000-0000-000000000000';

interface AccountRow {
  id: string;
  owner_id: string | null;
  asset: string;
  kind: string;
}

const accountKey = (owner: string | null, asset: string, kind: string): string =>
  `${owner ?? '-'}|${asset}|${kind}`;

export class PgLedgerStore implements LedgerStore {
  constructor(
    private readonly trx: Transaction<DB>,
    private readonly onRefused: () => void,
  ) {}

  async openUserAccounts(userId: string): Promise<void> {
    await this.trx
      .insertInto('accounts')
      .values(
        ASSETS.flatMap((asset) =>
          (['AVAILABLE', 'HELD'] as const).map((kind) => ({ owner_id: userId, asset, kind })),
        ),
      )
      .execute();
  }

  async lock(accounts: readonly AccountRef[]): Promise<void> {
    if (accounts.length > 0) await this.lockAccounts(accounts);
  }

  async post(journal: Journal): Promise<'POSTED' | 'INSUFFICIENT_FUNDS'> {
    const ids = await this.lockAccounts(journal.postings.map((posting) => posting.account));
    const lines = journal.postings.map(({ account, amount }) => {
      const accountId = ids.get(accountKey(account.owner, account.asset, account.kind));
      if (!accountId)
        throw new InvariantViolation(`Missing account ${account.asset} ${account.kind}`);
      return { accountId, amount };
    });
    const deltas = new Map<string, bigint>();
    for (const { accountId, amount } of lines)
      deltas.set(accountId, (deltas.get(accountId) ?? 0n) + amount);
    try {
      await sql`
        update accounts set balance = balance + v.delta
        from unnest(${[...deltas.keys()]}::bigint[], ${[...deltas.values()].map(formatAmount)}::numeric[])
          as v(id, delta)
        where accounts.id = v.id`.execute(this.trx);
    } catch (error) {
      if (pgConstraint(error) !== 'accounts_user_non_negative') throw error;
      this.onRefused();
      return 'INSUFFICIENT_FUNDS';
    }
    const journalId = randomUUID();
    await this.trx
      .insertInto('journal_entries')
      .values(
        lines.map(({ accountId, amount }) => ({
          journal_id: journalId,
          account_id: accountId,
          amount: formatAmount(amount),
          reason: journal.reason,
          ref_id: journal.refId,
        })),
      )
      .execute();
    return 'POSTED';
  }

  // Row locks in id order keep concurrent journals deadlock free.
  // The coalesce join matches the accounts_lookup index; NULL owner = exchange.
  private async lockAccounts(refs: readonly AccountRef[]): Promise<Map<string, string>> {
    const { rows } = await sql<AccountRow>`
      select a.id, a.owner_id, a.asset, a.kind
      from accounts a
      join unnest(
        ${refs.map((ref) => ref.owner)}::uuid[],
        ${refs.map((ref) => ref.asset)}::text[],
        ${refs.map((ref) => ref.kind)}::text[]
      ) as r(owner_id, asset, kind)
        on coalesce(a.owner_id, ${EXCHANGE_OWNER}::uuid) = coalesce(r.owner_id, ${EXCHANGE_OWNER}::uuid)
        and a.asset = r.asset and a.kind = r.kind
      order by a.id
      for update of a`.execute(this.trx);
    return new Map(rows.map((row) => [accountKey(row.owner_id, row.asset, row.kind), row.id]));
  }
}
