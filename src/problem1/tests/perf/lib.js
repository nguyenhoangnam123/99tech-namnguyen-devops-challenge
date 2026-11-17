// Shared k6 building blocks: traders, the seeded book and one function per
// user action. Scenario files only decide rates and targets.
import { check, sleep } from 'k6';
import k6crypto from 'k6/crypto';
import exec from 'k6/execution';
import http from 'k6/http';

const BASE = __ENV.BASE_URL;
const SECRET = __ENV.CUSTODY_SECRET;
export const SYMBOL = 'BTC-USDT';
export const MID = 50000;

const uuid = () => globalThis.crypto.randomUUID();
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const lots = () => (Math.floor(Math.random() * 9 + 1) / 1000).toFixed(3);

// Setup traffic (password hashing, deposits) and warm-up are tagged apart
// from the load. Setup always passes its phase.
const scenarioPhase = () => (exec.scenario.name.startsWith('warmup') ? 'warmup' : 'load');

export function request(method, path, { token, body, name, phase = scenarioPhase() } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const payload = body === undefined ? null : JSON.stringify(body);
  return http.request(method, `${BASE}${path}`, payload, {
    headers,
    tags: { name: name || path, phase },
  });
}

// The auth limiter is per client IP; wait out its window instead of failing setup.
function withAuthBudget(send) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = send();
    if (response.status !== 429) return response;
    sleep(5);
  }
  throw new Error('auth rate limit never reset');
}

function deposit(token, asset, amount) {
  const { address } = request('GET', `/v1/deposit-addresses/${asset}`, {
    token,
    phase: 'setup',
  }).json();
  const body = JSON.stringify({ txId: `perf-${uuid()}`, address, asset, amount });
  const timestamp = String(Date.now());
  const signature = k6crypto.hmac('sha256', SECRET, `${timestamp}.${body}`, 'hex');
  const response = http.post(`${BASE}/v1/custody/deposits`, body, {
    headers: {
      'content-type': 'application/json',
      'x-custody-timestamp': timestamp,
      'x-custody-signature': signature,
    },
    tags: { phase: 'setup' },
  });
  if (response.status !== 200) throw new Error(`deposit failed ${response.status}`);
}

export const placeLimit = (token, order, phase) =>
  request('POST', '/v1/orders', {
    token,
    phase,
    name: 'POST /v1/orders',
    body: { clientOrderId: uuid(), symbol: SYMBOL, type: 'LIMIT', ...order },
  });

// Funded traders, plus `levels` resting price levels on each side of MID.
export function setupTraders(count, levels = 40) {
  const users = [];
  for (let i = 0; i < count; i++) {
    const body = { email: `perf-${uuid()}@example.test`, password: 'correct horse battery staple' };
    withAuthBudget(() => request('POST', '/v1/auth/register', { body, phase: 'setup' }));
    const token = withAuthBudget(() =>
      request('POST', '/v1/auth/login', { body, phase: 'setup' }),
    ).json('accessToken');
    deposit(token, 'BTC', '100');
    deposit(token, 'USDT', '10000000');
    users.push(token);
  }
  for (let level = 0; level < levels; level++) {
    const token = users[level % users.length];
    placeLimit(token, { side: 'BUY', price: String(MID - 1 - level), quantity: '0.5' }, 'setup');
    placeLimit(token, { side: 'SELL', price: String(MID + 1 + level), quantity: '0.5' }, 'setup');
  }
  untilPipelineDrained(users[0], levels);
  return { users, loadStartsAt: Date.now() };
}

// Matching and settlement are async. An IOC below every ask expires, and
// events settle in order, so its expiry means setup's orders are done.
function untilPipelineDrained(token, levels) {
  const order = {
    side: 'BUY',
    price: String(MID - levels - 1),
    quantity: '0.001',
    timeInForce: 'IOC',
  };
  const marker = placeLimit(token, order, 'setup').json('orderId');
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = request('GET', `/v1/orders/${marker}`, {
      token,
      phase: 'setup',
      name: 'GET /v1/orders/{id}',
    });
    if (response.json('status') === 'EXPIRED') return;
    sleep(0.5);
  }
  throw new Error('setup orders did not settle within 60s');
}

export function readDepth(_data, depthLevels = 20) {
  const response = request('GET', `/v1/markets/${SYMBOL}/depth?limit=${depthLevels}`, {
    name: 'depth',
  });
  check(response, { 'depth 200': (r) => r.status === 200 });
}

export function readTicker() {
  check(request('GET', `/v1/markets/${SYMBOL}/ticker`, { name: 'ticker' }), {
    'ticker 200': (r) => r.status === 200,
  });
}

export function readTrades() {
  const response = request('GET', `/v1/markets/${SYMBOL}/trades?limit=50`, { name: 'trades' });
  check(response, { 'trades 200': (r) => r.status === 200 });
}

export function readBalances(data) {
  const response = request('GET', '/v1/balances', { token: pick(data.users), name: 'balances' });
  check(response, { 'balances 200': (r) => r.status === 200 });
}

export function readOpenOrders(data) {
  const response = request('GET', '/v1/orders?status=open&limit=20', {
    token: pick(data.users),
    name: 'open orders',
  });
  check(response, { 'orders 200': (r) => r.status === 200 });
}

export function readFills(data) {
  const response = request('GET', `/v1/fills?symbol=${SYMBOL}&limit=20`, {
    token: pick(data.users),
    name: 'fills',
  });
  check(response, { 'fills 200': (r) => r.status === 200 });
}

// 80% passive orders away from the mid, 20% IOC orders that cross it.
export function placeOrder(data) {
  const side = Math.random() < 0.5 ? 'BUY' : 'SELL';
  const crossing = Math.random() < 0.2;
  const offset = crossing
    ? -Math.floor(Math.random() * 20) - 1
    : Math.floor(Math.random() * 1000) + 1;
  const price = side === 'BUY' ? MID - offset : MID + offset;
  const response = placeLimit(pick(data.users), {
    side,
    price: String(price),
    quantity: lots(),
    timeInForce: crossing ? 'IOC' : 'GTC',
  });
  check(response, { 'order accepted': (r) => r.status === 201 });
}

export function cancelOne(data) {
  const token = pick(data.users);
  const open = request('GET', `/v1/orders?status=open&symbol=${SYMBOL}&limit=1`, {
    token,
    name: 'open orders',
  });
  const order = open.json('orders.0');
  if (!order || order.cancelRequested) return;
  const response = request('DELETE', `/v1/orders/${order.orderId}`, {
    token,
    name: 'DELETE /v1/orders/{id}',
  });
  check(response, { 'cancel accepted': (r) => r.status === 202 });
}
