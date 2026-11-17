import { describe, expect, it } from 'vitest';
import { type Md, type Oms, Trader, call } from '../support/api.js';

// The edge, the OpenAPI validator and the handlers agree on one contract.
describe('API contract', () => {
  it('lists markets with their trading rules', async () => {
    const { status, body } = await call<Md['MarketList']>('GET', '/v1/markets');

    expect(status).toBe(200);
    expect(body.markets.map((market) => market.symbol)).toEqual(['BTC-USDT', 'ETH-USDT']);
    expect(body.markets[0]).toMatchObject({
      tickSize: '0.01',
      lotSize: '0.00001',
      takerFeeRate: '0.001',
    });
  });

  it('answers errors as RFC 9457 problems with a machine code', async () => {
    const response = await call<Oms['Problem']>('GET', '/v1/balances');

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('rejects fields the contract does not declare', async () => {
    const trader = await Trader.create();
    const response = await call<Oms['Problem']>('POST', '/v1/orders', {
      token: trader.token,
      body: {
        clientOrderId: 'x1',
        symbol: 'ETH-USDT',
        side: 'BUY',
        type: 'LIMIT',
        price: '1',
        quantity: '1',
        userId: 'someone-else',
      },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['exponent notation', '1e3'],
    ['too many decimals', '1.0000000000000000001'],
    ['negative', '-5'],
  ])('rejects a %s amount before it reaches the domain', async (_label, price) => {
    const trader = await Trader.create();
    const response = await trader.place({
      symbol: 'ETH-USDT',
      side: 'BUY',
      type: 'LIMIT',
      price,
      quantity: '1',
    });

    expect(response.status).toBe(400);
  });

  it('echoes a request id for tracing', async () => {
    const response = await call('GET', '/v1/markets');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each(['/metrics', '/readyz', '/v1/unknown'])(
    'does not expose %s at the edge',
    async (path) => {
      const response = await call<Oms['Problem']>('GET', path);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    },
  );
});
