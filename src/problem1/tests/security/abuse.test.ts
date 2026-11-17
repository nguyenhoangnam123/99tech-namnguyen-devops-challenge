import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { SignJWT, UnsecuredJWT } from 'jose';
import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type Oms, Trader, call, uniqueId } from '../support/api.js';
import { env } from '../support/env.js';
import { ledgerViolations } from '../support/ledger.js';

// Business-logic abuse that scanners do not find. Every case is
// something a real exchange has been attacked with.
const SYMBOL = 'ETH-USDT';
const traders: Trader[] = [];

async function funded(usdt: number): Promise<Trader> {
  const trader = await Trader.create('abuse');
  traders.push(trader);
  await trader.fund('USDT', String(usdt));
  return trader;
}

const limitBuy = (price: string, quantity: string) =>
  ({ symbol: SYMBOL, side: 'BUY', type: 'LIMIT', price, quantity }) as const;

afterAll(async () => {
  await Promise.all(traders.map((trader) => trader.cancelAllOpen()));
  expect(await ledgerViolations()).toEqual({});
});

describe('access control', () => {
  it("answers 404 for another user's order, never 403, and leaves it untouched", async () => {
    const owner = await funded(100);
    const intruder = await Trader.create('intruder');
    const order = await owner.place(limitBuy('10', '1'));

    expect((await intruder.order(order.body.orderId)).status).toBe(404);
    expect((await intruder.cancel(order.body.orderId)).status).toBe(404);
    expect((await owner.order(order.body.orderId)).body).toMatchObject({
      status: 'NEW',
      cancelRequested: false,
    });
  });
});

describe('money', () => {
  it('cannot overspend a balance with concurrent orders', async () => {
    const trader = await funded(50);

    const responses = await Promise.all(
      Array.from({ length: 15 }, () => trader.place(limitBuy('10', '1'))),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(5);
    expect(responses.filter((r) => r.body.code === 'INSUFFICIENT_FUNDS')).toHaveLength(10);
    expect(await trader.balance('USDT')).toMatchObject({ available: '0', held: '50' });
  });

  it('creates one order when one client order id races with itself', async () => {
    const trader = await funded(100);
    const request = { ...limitBuy('10', '1'), clientOrderId: uniqueId('race') };

    const responses = await Promise.all(Array.from({ length: 10 }, () => trader.place(request)));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.orderId)).size).toBe(1);
    expect(await trader.balance('USDT')).toMatchObject({ available: '90', held: '10' });
  });
});

describe('token forgery', () => {
  const claims = { iss: 'exchange-oms', aud: 'exchange-api' };
  const privateKey = createPrivateKey(env.jwtPrivateKey());
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();

  const forged: [string, () => Promise<string>][] = [
    [
      'alg none',
      () =>
        Promise.resolve(
          new UnsecuredJWT({ ...claims, sub: randomUUID() }).setExpirationTime('5m').encode(),
        ),
    ],
    [
      'HS256 keyed with the public key',
      () =>
        new SignJWT({ ...claims, sub: randomUUID() })
          .setProtectedHeader({ alg: 'HS256' })
          .setExpirationTime('5m')
          .sign(new TextEncoder().encode(publicPem)),
    ],
    [
      'an expired token',
      () =>
        new SignJWT({ ...claims, sub: randomUUID() })
          .setProtectedHeader({ alg: 'EdDSA' })
          .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
          .sign(privateKey),
    ],
    [
      'the wrong audience',
      () =>
        new SignJWT({ ...claims, aud: 'another-api', sub: randomUUID() })
          .setProtectedHeader({ alg: 'EdDSA' })
          .setExpirationTime('5m')
          .sign(privateKey),
    ],
  ];

  it.each(forged)('rejects %s', async (_label, forge) => {
    const response = await call<Oms['Problem']>('GET', '/v1/balances', { token: await forge() });
    expect(response.status).toBe(401);
  });

  it('rejects a token whose payload was edited', async () => {
    const trader = await Trader.create('victim');
    const [header, , signature] = trader.token.split('.');
    const payload = Buffer.from(
      JSON.stringify({ ...claims, sub: randomUUID(), exp: 9_999_999_999 }),
    ).toString('base64url');

    const response = await call('GET', '/v1/balances', {
      token: `${header ?? ''}.${payload}.${signature ?? ''}`,
    });

    expect(response.status).toBe(401);
  });
});

describe('input hardening', () => {
  it('refuses oversized bodies at the edge', async () => {
    const trader = await Trader.create('big');
    const response = await call<Oms['Problem']>('POST', '/v1/orders', {
      token: trader.token,
      rawBody: JSON.stringify({ clientOrderId: 'x', padding: 'a'.repeat(20_000) }),
    });

    expect(response.status).toBe(413);
    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it.each([
    ['an injection in a path id', "/v1/orders/1'%20OR%20'1'='1"],
    ['an injection in a query', '/v1/orders?symbol=ETH-USDT%27--'],
  ])('rejects %s by contract, before any query runs', async (_label, path) => {
    const trader = await Trader.create('inject');
    const response = await call<Oms['Problem']>('GET', path, { token: trader.token });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toMatch(/node_modules|at \w+ \(|stack/);
  });

  it('sends defensive headers on every response', async () => {
    const { headers } = await call('GET', '/v1/markets');

    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('x-powered-by')).toBeNull();
    expect(headers.get('server')).toBe('nginx');
  });

  it('closes a WebSocket that sends an oversized frame', async () => {
    const socket = new WebSocket(`${env.baseUrl.replace('http', 'ws')}/v1/ws`);
    await new Promise((resolve) => socket.once('open', resolve));

    socket.send('x'.repeat(8_192));
    const code = await new Promise<number>((resolve) => socket.once('close', resolve));

    expect(code).toBe(1009);
  });
});

// Runs last: it spends this client's per-IP auth budget for a minute.
describe('credential guessing', () => {
  it('locks an account after ten bad passwords, whatever the password', async () => {
    const victim = await Trader.create('locked');
    const attempt = (password: string) =>
      call('POST', '/v1/auth/login', { body: { email: victim.email, password } });

    const guesses = [];
    for (let i = 0; i < 11; i++)
      guesses.push((await attempt(`wrong-password-${String(i)}`)).status);

    expect(guesses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(guesses[10]).toBe(429);
    expect((await attempt('correct horse battery staple')).status).toBe(429);
  });

  // Regression: the lockout read the counter before writing it, so a
  // concurrent burst all saw zero failures and got through.
  it('counts concurrent guesses atomically', async () => {
    const victim = await Trader.create('burst');
    const statuses = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        call('POST', '/v1/auth/login', {
          body: { email: victim.email, password: `burst-guess-${String(i)}` },
        }).then((r) => r.status),
      ),
    );

    expect(statuses.filter((status) => status !== 429).length).toBeLessThanOrEqual(10);
  });

  it('keys the per-IP limit on the real client, not a spoofed X-Forwarded-For', async () => {
    const statuses = await Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        call('POST', '/v1/auth/login', {
          body: { email: `${uniqueId('nobody')}@example.test`, password: 'irrelevant-password' },
          headers: { 'x-forwarded-for': `203.0.113.${String(i % 150)}` },
        }).then((r) => r.status),
      ),
    );

    expect(statuses).toContain(429);
  }, 60_000);
});
