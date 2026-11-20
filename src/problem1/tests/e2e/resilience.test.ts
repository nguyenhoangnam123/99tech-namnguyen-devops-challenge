import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Trader, eventually, freePrice } from '../support/api.js';
import { ledgerViolations, scalar } from '../support/ledger.js';

// Restarts containers, so it only runs with CHAOS=1 (make chaos).
const deploy = (file: string): string =>
  fileURLToPath(new URL(`../../deploy/${file}`, import.meta.url));

function compose(...args: string[]): string {
  return execFileSync(
    'docker',
    ['compose', '--env-file', deploy('.env'), '-f', deploy('docker-compose.yml'), ...args],
    { encoding: 'utf8' },
  );
}

const healthy = (service: string): Promise<string> =>
  eventually(
    () => Promise.resolve(compose('ps', service, '--format', '{{.Health}}').trim()),
    (health) => health === 'healthy',
    90_000,
  );

const SYMBOL = 'ETH-USDT';
const traders: Trader[] = [];

async function trader(funds: Partial<Record<'ETH' | 'USDT', string>>): Promise<Trader> {
  const created = await Trader.create('chaos');
  traders.push(created);
  for (const [asset, amount] of Object.entries(funds))
    await created.fund(asset as 'ETH' | 'USDT', amount);
  return created;
}

describe.runIf(process.env.CHAOS === '1')('resilience', () => {
  afterEach(async () => {
    await Promise.all(traders.splice(0).map((t) => t.cancelAllOpen()));
    expect(await ledgerViolations()).toEqual({});
  });

  it('rebuilds the order book by replaying the command log after a matcher restart', async () => {
    const price = await freePrice(SYMBOL);
    const seller = await trader({ ETH: '1' });
    const buyer = await trader({ USDT: String(price) });
    const ask = await seller.place({
      symbol: SYMBOL,
      side: 'SELL',
      type: 'LIMIT',
      price: `${price}`,
      quantity: '0.5',
    });
    await seller.orderWhen(ask.body.orderId, ['NEW']);

    compose('restart', 'matcher');
    await healthy('matcher');
    const bid = await buyer.place({
      symbol: SYMBOL,
      side: 'BUY',
      type: 'LIMIT',
      price: `${price}`,
      quantity: '0.5',
    });

    expect(await buyer.orderWhen(bid.body.orderId, ['FILLED'])).toMatchObject({
      filledQuantity: '0.5',
    });
    expect(await seller.orderWhen(ask.body.orderId, ['FILLED'])).toMatchObject({
      filledQuantity: '0.5',
    });
  }, 120_000);

  it('settles every trade exactly once across a settler crash', async () => {
    const price = await freePrice(SYMBOL);
    const seller = await trader({ ETH: '2' });
    const buyer = await trader({ USDT: String(price * 2) });
    const ask = await seller.place({
      symbol: SYMBOL,
      side: 'SELL',
      type: 'LIMIT',
      price: `${price}`,
      quantity: '1',
    });
    await seller.orderWhen(ask.body.orderId, ['NEW']);

    const bids: string[] = [];
    for (let i = 0; i < 20; i++) {
      if (i === 8) compose('kill', '-s', 'SIGKILL', 'oms-settler');
      const bid = await buyer.place({
        symbol: SYMBOL,
        side: 'BUY',
        type: 'LIMIT',
        price: `${price}`,
        quantity: '0.05',
      });
      bids.push(bid.body.orderId);
    }
    // start, not up: up may recreate oms-api mid-test when configs differ.
    compose('start', 'oms-settler');
    await healthy('oms-settler');

    for (const id of bids) await buyer.orderWhen(id, ['FILLED']);
    expect(await seller.orderWhen(ask.body.orderId, ['FILLED'])).toMatchObject({
      filledQuantity: '1',
    });
    const fills = await scalar<string>(
      'select count(*)::text as value from fills where order_id = $1',
      [ask.body.orderId],
    );
    expect(fills).toBe('20');
  }, 180_000);
});
