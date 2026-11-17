import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Oms, Trader, call, custodyHeaders, notifyDeposit, uniqueId } from '../support/api.js';
import { ledgerViolations, scalar } from '../support/ledger.js';

// The custody provider retries, duplicates and reorders callbacks.
// A deposit must be credited exactly once whatever it does.
describe('custody deposits', () => {
  let trader: Trader;
  let address: string;

  beforeAll(async () => {
    trader = await Trader.create('depositor');
    address = (
      await call<Oms['DepositAddress']>('GET', '/v1/deposit-addresses/ETH', { token: trader.token })
    ).body.address;
  });

  afterAll(async () => {
    expect(await ledgerViolations()).toEqual({});
  });

  it('credits a confirmed deposit to the address owner', async () => {
    const before = await trader.balance('ETH');
    const receipt = await notifyDeposit({
      txId: uniqueId('tx'),
      address,
      asset: 'ETH',
      amount: '1.25',
    });

    expect(receipt.status).toBe(200);
    expect(receipt.body).toMatchObject({ status: 'CREDITED', duplicate: false });
    expect(Number((await trader.balance('ETH')).available) - Number(before.available)).toBeCloseTo(
      1.25,
      12,
    );
  });

  it('acknowledges a redelivery without crediting again', async () => {
    const notice = { txId: uniqueId('tx'), address, asset: 'ETH' as const, amount: '2' };
    await notifyDeposit(notice);
    const afterFirst = await trader.balance('ETH');

    const replay = await notifyDeposit(notice);

    expect(replay.body).toMatchObject({ status: 'CREDITED', duplicate: true });
    expect(await trader.balance('ETH')).toEqual(afterFirst);
  });

  it('credits once when the same callback arrives 25 times concurrently', async () => {
    const before = await trader.balance('ETH');
    const notice = { txId: uniqueId('tx'), address, asset: 'ETH' as const, amount: '0.5' };

    const receipts = await Promise.all(Array.from({ length: 25 }, () => notifyDeposit(notice)));

    expect(receipts.map((r) => r.status)).toEqual(Array(25).fill(200));
    expect(receipts.filter((r) => !r.body.duplicate)).toHaveLength(1);
    expect(Number((await trader.balance('ETH')).available) - Number(before.available)).toBeCloseTo(
      0.5,
      12,
    );
    expect(
      await scalar<string>(
        'select count(*)::text as value from journal_entries where ref_id = $1',
        [notice.txId],
      ),
    ).toBe('2');
  });

  it('refuses to reuse a transaction id for different content', async () => {
    const txId = uniqueId('tx');
    await notifyDeposit({ txId, address, asset: 'ETH', amount: '1' });

    const conflict = await notifyDeposit({ txId, address, asset: 'ETH', amount: '100' });

    expect(conflict.status).toBe(409);
  });

  it('parks deposits to unknown addresses or the wrong asset instead of crediting', async () => {
    const unknown = await notifyDeposit({
      txId: uniqueId('tx'),
      address: 'eth1nobody',
      asset: 'ETH',
      amount: '3',
    });
    const wrongAsset = await notifyDeposit({
      txId: uniqueId('tx'),
      address,
      asset: 'BTC',
      amount: '3',
    });

    expect(unknown.body.status).toBe('UNMATCHED');
    expect(wrongAsset.body.status).toBe('UNMATCHED');
    expect((await trader.balance('BTC')).available).toBe('0');
  });

  it.each([
    [
      'a bad signature',
      (body: string) => ({ ...custodyHeaders(body), 'x-custody-signature': '00'.repeat(32) }),
    ],
    ['a stale timestamp', (body: string) => custodyHeaders(body, Date.now() - 10 * 60 * 1000)],
    ['a signature for another body', () => custodyHeaders('{"txId":"other"}')],
  ])('rejects a callback with %s', async (_label, headersFor) => {
    const rawBody = JSON.stringify({ txId: uniqueId('tx'), address, asset: 'ETH', amount: '1000' });

    const response = await call('POST', '/v1/custody/deposits', {
      rawBody,
      headers: headersFor(rawBody),
    });

    expect(response.status).toBe(401);
  });
});
