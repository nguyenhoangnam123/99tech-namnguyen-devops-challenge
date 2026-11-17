import { createHmac, randomUUID } from 'node:crypto';
import type { MarketDataApi, OmsApi } from '@exchange/contracts';
import { env } from './env.js';

export type Oms = OmsApi.components['schemas'];
export type Md = MarketDataApi.components['schemas'];

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

export async function call<T = unknown>(method: string, path: string, options: CallOptions = {}): Promise<Response<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (payload !== undefined) headers['content-type'] ??= 'application/json';
  const response = await fetch(`${env.baseUrl}${path}`, { method, headers, body: payload });
  const text = await response.text();
  const isJson = response.headers.get('content-type')?.includes('json') ?? false;
  const body = isJson && text ? (JSON.parse(text) as T) : (text as T);
  return { status: response.status, body, headers: response.headers };
}

export function custodyHeaders(rawBody: string, timestamp = Date.now()): Record<string, string> {
  const signature = createHmac('sha256', env.custodySecret).update(`${String(timestamp)}.`).update(rawBody).digest('hex');
  return { 'x-custody-timestamp': String(timestamp), 'x-custody-signature': signature };
}

export function notifyDeposit(notice: Oms['DepositNotice']): Promise<Response<Oms['DepositReceipt'] & Oms['Problem']>> {
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
    const password = 'correct horse battery staple';
    const registered = await call<Oms['Registered']>('POST', '/v1/auth/register', { body: { email, password } });
    if (registered.status !== 201) throw new Error(`register failed: ${String(registered.status)}`);
    const login = await call<Oms['Token']>('POST', '/v1/auth/login', { body: { email, password } });
    if (login.status !== 200) throw new Error(`login failed: ${String(login.status)}`);
    return new Trader(email, registered.body.userId, login.body.accessToken);
  }

  async fund(asset: Oms['Asset'], amount: string): Promise<void> {
    const { body } = await call<Oms['DepositAddress']>('GET', `/v1/deposit-addresses/${asset}`, { token: this.token });
    const receipt = await notifyDeposit({ txId: uniqueId('tx'), address: body.address, asset, amount });
    if (receipt.body.status !== 'CREDITED') throw new Error('deposit not credited');
  }

  async balance(asset: Oms['Asset']): Promise<Oms['Balance']> {
    const { body } = await call<Oms['BalanceList']>('GET', '/v1/balances', { token: this.token });
    const balance = body.balances.find((entry) => entry.asset === asset);
    if (!balance) throw new Error(`no ${asset} balance`);
    return balance;
  }

  place(order: Omit<Oms['PlaceOrderRequest'], 'clientOrderId'> & { clientOrderId?: string }) {
    return call<Oms['Order'] & Oms['Problem']>('POST', '/v1/orders', {
      token: this.token,
      body: { clientOrderId: uniqueId('c'), ...order },
    });
  }

  order(orderId: string) {
    return call<Oms['Order'] & Oms['Problem']>('GET', `/v1/orders/${orderId}`, { token: this.token });
  }

  cancel(orderId: string) {
    return call<Oms['Order'] & Oms['Problem']>('DELETE', `/v1/orders/${orderId}`, { token: this.token });
  }

  async fills(symbol: Oms['Symbol']): Promise<Oms['Fill'][]> {
    const { body } = await call<Oms['FillList']>('GET', `/v1/fills?symbol=${symbol}`, { token: this.token });
    return body.fills;
  }

  async cancelAllOpen(): Promise<void> {
    const { body } = await call<Oms['OrderList']>('GET', '/v1/orders?status=open', { token: this.token });
    await Promise.all(body.orders.map((order) => this.cancel(order.orderId)));
  }

  // Waits until the order reaches a terminal or expected status.
  async orderWhen(orderId: string, statuses: readonly Oms['OrderStatus'][]): Promise<Oms['Order']> {
    return eventually(
      async () => (await this.order(orderId)).body,
      (order) => statuses.includes(order.status),
    );
  }
}

export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not met in ${String(timeoutMs)} ms: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function depth(symbol: Md['Symbol']): Promise<Md['Depth']> {
  return (await call<Md['Depth']>('GET', `/v1/markets/${symbol}/depth?limit=100`)).body;
}

// A price strictly inside the current spread, so a test only trades with itself.
export async function freePrice(symbol: Md['Symbol']): Promise<number> {
  const { bids, asks } = await depth(symbol);
  const bestBid = bids[0] ? Number(bids[0][0]) : undefined;
  const bestAsk = asks[0] ? Number(asks[0][0]) : undefined;
  if (bestBid === undefined && bestAsk === undefined) return 2000;
  if (bestBid === undefined) return Math.round((bestAsk ?? 0) * 0.5);
  if (bestAsk === undefined) return Math.round(bestBid * 2);
  const mid = Math.round((bestBid + bestAsk) / 2);
  if (mid - bestBid < 10 || bestAsk - mid < 10) throw new Error(`spread too tight: ${String(bestBid)}/${String(bestAsk)}`);
  return mid;
}
