import type { Asset } from './markets.js';
import type { Amount } from './money.js';
import type { Reservation } from './orders.js';
import { InvariantViolation } from './result.js';

export type UserAccountKind = 'AVAILABLE' | 'HELD';
export type ExchangeAccountKind = 'EXTERNAL' | 'FEES';
export type AccountKind = UserAccountKind | ExchangeAccountKind;

export type AccountRef =
  | { readonly owner: string; readonly asset: Asset; readonly kind: UserAccountKind }
  | { readonly owner: null; readonly asset: Asset; readonly kind: ExchangeAccountKind };

export interface Posting {
  readonly account: AccountRef;
  readonly amount: Amount;
}

export type JournalReason = 'DEPOSIT' | 'ORDER_HOLD' | 'ORDER_RELEASE' | 'TRADE';

// A balanced set of postings: the only way balances change.
export interface Journal {
  readonly reason: JournalReason;
  readonly refId: string;
  readonly postings: readonly Posting[];
}

export const userAccount = (owner: string, asset: Asset, kind: UserAccountKind): AccountRef => ({
  owner,
  asset,
  kind,
});

export const exchangeAccount = (asset: Asset, kind: ExchangeAccountKind): AccountRef => ({
  owner: null,
  asset,
  kind,
});

export function journal(
  reason: JournalReason,
  refId: string,
  postings: readonly Posting[],
): Journal {
  const nonZero = postings.filter((posting) => posting.amount !== 0n);
  assertBalanced(nonZero, refId);
  return { reason, refId, postings: nonZero };
}

function assertBalanced(postings: readonly Posting[], refId: string): void {
  const totals = new Map<Asset, Amount>();
  for (const { account, amount } of postings) {
    totals.set(account.asset, (totals.get(account.asset) ?? 0n) + amount);
  }
  for (const [asset, total] of totals) {
    if (total !== 0n) throw new InvariantViolation(`Journal ${refId} is off by ${total} ${asset}`);
  }
}

export interface DepositFact {
  readonly txId: string;
  readonly userId: string;
  readonly asset: Asset;
  readonly amount: Amount;
}

export function depositJournal(deposit: DepositFact): Journal {
  return journal('DEPOSIT', deposit.txId, [
    { account: exchangeAccount(deposit.asset, 'EXTERNAL'), amount: -deposit.amount },
    { account: userAccount(deposit.userId, deposit.asset, 'AVAILABLE'), amount: deposit.amount },
  ]);
}

export function holdJournal(orderId: string, userId: string, reservation: Reservation): Journal {
  return moveBetween('ORDER_HOLD', orderId, userId, reservation, 'AVAILABLE', 'HELD');
}

export function releaseJournal(orderId: string, userId: string, reservation: Reservation): Journal {
  return moveBetween('ORDER_RELEASE', orderId, userId, reservation, 'HELD', 'AVAILABLE');
}

function moveBetween(
  reason: JournalReason,
  refId: string,
  userId: string,
  { asset, amount }: Reservation,
  from: UserAccountKind,
  to: UserAccountKind,
): Journal {
  return journal(reason, refId, [
    { account: userAccount(userId, asset, from), amount: -amount },
    { account: userAccount(userId, asset, to), amount },
  ]);
}
