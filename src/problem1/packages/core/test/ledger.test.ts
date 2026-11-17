import { describe, expect, it } from 'vitest';
import {
  depositJournal,
  exchangeAccount,
  holdJournal,
  journal,
  userAccount,
} from '../src/ledger.js';
import { InvariantViolation } from '../src/result.js';
import { amt } from './fixtures.js';

describe('ledger journals', () => {
  it('refuses an unbalanced journal', () => {
    expect(() =>
      journal('DEPOSIT', 'tx-1', [
        { account: userAccount('u', 'BTC', 'AVAILABLE'), amount: amt('1') },
      ]),
    ).toThrow(InvariantViolation);
  });

  it('balances per asset, not in total', () => {
    expect(() =>
      journal('TRADE', 't-1', [
        { account: userAccount('u', 'BTC', 'AVAILABLE'), amount: amt('1') },
        { account: userAccount('u', 'USDT', 'AVAILABLE'), amount: -amt('1') },
      ]),
    ).toThrow(/off by/);
  });

  it('drops zero postings', () => {
    const result = journal('TRADE', 't-2', [
      { account: exchangeAccount('BTC', 'FEES'), amount: 0n },
      { account: userAccount('u', 'BTC', 'AVAILABLE'), amount: amt('1') },
      { account: userAccount('u', 'BTC', 'HELD'), amount: -amt('1') },
    ]);
    expect(result.postings).toHaveLength(2);
  });

  it('credits a deposit against the custody mirror account', () => {
    expect(
      depositJournal({ txId: 'tx-9', userId: 'u', asset: 'ETH', amount: amt('3') }).postings,
    ).toEqual([
      { account: exchangeAccount('ETH', 'EXTERNAL'), amount: -amt('3') },
      { account: userAccount('u', 'ETH', 'AVAILABLE'), amount: amt('3') },
    ]);
  });

  it('holds by moving available to held', () => {
    expect(holdJournal('o-1', 'u', { asset: 'USDT', amount: amt('10') }).postings).toEqual([
      { account: userAccount('u', 'USDT', 'AVAILABLE'), amount: -amt('10') },
      { account: userAccount('u', 'USDT', 'HELD'), amount: amt('10') },
    ]);
  });
});
