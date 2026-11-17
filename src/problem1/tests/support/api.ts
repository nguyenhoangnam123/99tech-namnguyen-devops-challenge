import { createHmac, randomUUID } from 'node:crypto';
import type { MarketDataApi, OmsApi } from '@exchange/contracts';
import { env } from './env.js';

export type Oms = OmsApi.components['schemas'];
export type Md = MarketDataApi.components['schemas'];

// Success bodies plus the problem code a failure carries.
interface ProblemCode {
  code?: string;
}
export type OrderOrProblem = Oms['Order'] & ProblemCode;

export interface Response<T> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

interface CallOptions {
  readonly token?: string;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly headers?: Record<string, string>;
}

export async function call<T = unknown>(
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const payload =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (payload !== undefined) headers['content-type'] ??= 'application/json';
  const response = await fetch(`${env.baseUrl}${path}`, { method, headers, body: payload });
  const text = await response.text();
  const isJson = response.headers.get('content-type')?.includes('json') ?? false;
  const body = isJson && text ? (JSON.parse(text) as T) : (text as T);
  return { status: response.status, body, headers: response.headers };
}

export function custodyHeaders(rawBody: string, timestamp = Date.now()): Record<string, string> {
  const signature = createHmac('sha256', env.custodySecret)
    .update(`${String(timestamp)}.`)
    .update(rawBody)
    .digest('hex');
  return { 'x-custody-timestamp': String(timestamp), 'x-custody-signature': signature };
}

export function notifyDeposit(
  notice: Oms['DepositNotice'],
): Promise<Response<Oms['DepositReceipt'] & ProblemCode>> {
  const rawBody = JSON.stringify(notice);
  return call('POST', '/v1/custody/deposits', { rawBody, headers: custodyHeaders(rawBody) });
}

export const uniqueId = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`;

// A registered, logged-in user with helpers for the flows under test.
export class Trader {
  private constructor(
    readonly email: string,
    readonly userId: string,
    readonly token: string,
  ) {}

  static async create(name = 'trader'): Promise<Trader> {
    const email = `${uniqueId(name)}@example.test`;
    const body = { email, password: 'correct horse battery staple' };
    const registered = await withAuthBudget(() =>
      call<Oms['Registered']>('POST', '/v1/auth/register', { body }),
    );
    if (registered.status !== 201) throw new Error(`register failed: ${String(registered.status)}`);
    const login = await withAuthBudget(() =>
      call<Oms['Token']>('POST', '/v1/auth/login', { body }),
    );
    if (login.status !== 200) throw new Error(`login failed: ${String(login.status)}`);
    return new Trader(email, registered.body.userId, login.body.accessToken);
  }

  async fund(asset: Oms['Asset'], amount: string): Promise<void> {
    const { body } = await call<Oms['DepositAddress']>('GET', `/v1/deposit-addresses/${asset}`, {
      token: this.token,
    });
    const receipt = await notifyDeposit({
      txId: uniqueId('tx'),
      address: body.address,
      asset,
      amount,
    });
    if (receipt.body.status !== 'CREDITED') throw new Error('deposit not credited');
  }

  async balance(asset: Oms['Asset']): Promise<Oms['Balance']> {
    const { body } = await call<Oms['BalanceList']>('GET', '/v1/balances', { token: this.token });
    const balance = body.balances.find((entry) => entry.asset === asset);
    if (!balance) throw new Error(`no ${asset} balance`);
    return balance;
  }

  place(order: Omit<Oms['PlaceOrderRequest'], 'clientOrderId'> & { clientOrderId?: string }) {
    return call<OrderOrProblem>('POST', '/v1/orders', {
      token: this.token,
      body: { clientOrderId: uniqueId('c'), ...order },
    });
  }

  order(orderId: string) {
    return call<OrderOrProblem>('GET', `/v1/orders/${orderId}`, {
      token: this.token,
    });
  }

  cancel(orderId: string) {
    return call<OrderOrProblem>('DELETE', `/v1/orders/${orderId}`, {
      token: this.token,
    });
  }

  async fills(symbol: Oms['Symbol']): Promise<Oms['Fill'][]> {
    const { body } = await call<Oms['FillList']>('GET', `/v1/fills?symbol=${symbol}`, {
      token: this.token,
    });
    return body.fills;
  }

  // Cancels and waits until the matcher has closed every open order.
  async cancelAllOpen(): Promise<void> {
    const open = async () =>
      (await call<Oms['OrderList']>('GET', '/v1/orders?status=open', { token: this.token })).body
        .orders;
    const orders = await open();
    const responses = await Promise.all(orders.map((order) => this.cancel(order.orderId)));
    if (responses.some((r) => r.status !== 202)) throw new Error('cancel request failed');
    await eventually(open, (remaining) => remaining.length === 0);
  }

  // Waits until the order reaches a terminal or expected status.
  async orderWhen(orderId: string, statuses: readonly Oms['OrderStatus'][]): Promise<Oms['Order']> {
    return eventually(
      async () => (await this.order(orderId)).body,
      (order) => statuses.includes(order.status),
    );
  }
}

// The auth limiter is per client IP and suites share one IP; the abuse
// suite spends the budget on purpose, so wait out its window.
async function withAuthBudget<T>(send: () => Promise<Response<T>>): Promise<Response<T>> {
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    if (response.status !== 429 || attempt === 15) return response;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`condition not met in ${String(timeoutMs)} ms: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function depth(symbol: Md['Symbol']): Promise<Md['Depth']> {
  return (await call<Md['Depth']>('GET', `/v1/markets/${symbol}/depth?limit=100`)).body;
}

// A whole price strictly inside the current spread, so a test only
// trades with itself. Stale bids below are fine; asks above are fine.
export async function freePrice(symbol: Md['Symbol']): Promise<number> {
  const { bids, asks } = await depth(symbol);
  const bestBid = bids[0] ? Number(bids[0][0]) : 0;
  const bestAsk = asks[0] ? Number(asks[0][0]) : Math.max(bestBid * 4, 4000);
  const price = Math.floor((bestBid + bestAsk) / 2);
  if (price <= bestBid || price >= bestAsk)
    throw new Error(`no room in spread ${String(bestBid)}/${String(bestAsk)}`);
  return price;
}
