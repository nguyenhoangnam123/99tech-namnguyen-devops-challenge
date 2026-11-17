// 500 rps open-model load at the P1 target: p99 < 100 ms per request.
// Arrival rate is fixed, so a slow system cannot hide by slowing the client.
import { check, sleep } from 'k6';
import k6crypto from 'k6/crypto';
import http from 'k6/http';

const BASE = __ENV.BASE_URL;
const SECRET = __ENV.CUSTODY_SECRET;
const DURATION = __ENV.DURATION || '2m';
// Same mix at a fraction of the rate, for shared CI runners.
const RATE_SCALE = Number(__ENV.RATE_SCALE || 1);
const SYMBOL = 'BTC-USDT';
const USERS = 40;
const MID = 50000;

const scenario = (fullRate, exec) => ({
  executor: 'constant-arrival-rate',
  rate: Math.max(1, Math.round(fullRate * RATE_SCALE)),
  timeUnit: '1s',
  duration: DURATION,
  preAllocatedVUs: Math.max(5, Math.ceil(fullRate / 4)),
  maxVUs: fullRate * 2,
  exec,
});

export const options = {
  setupTimeout: '5m',
  scenarios: {
    depth: scenario(125, 'readDepth'),
    ticker: scenario(50, 'readTicker'),
    trades: scenario(50, 'readTrades'),
    balances: scenario(50, 'readBalances'),
    open_orders: scenario(50, 'readOpenOrders'),
    place: scenario(125, 'placeOrder'),
    cancel: scenario(25, 'cancelOne'),
  },
  thresholds: {
    'http_req_failed{phase:load}': ['rate<0.001'],
    checks: ['rate>0.999'],
    'http_req_duration{phase:load}': ['p(99)<100'],
    'http_req_duration{scenario:place}': ['p(99)<100'],
    'http_req_duration{scenario:depth}': ['p(99)<100'],
    'http_req_duration{scenario:balances}': ['p(99)<100'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const uuid = () => globalThis.crypto.randomUUID();

// Setup traffic (password hashing, deposits) is tagged apart from the load.
function request(method, path, { token, body, name, phase = 'load' } = {}) {
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

const placeLimit = (token, order, phase = 'load') =>
  request('POST', '/v1/orders', {
    token,
    phase,
    name: 'POST /v1/orders',
    body: { clientOrderId: uuid(), symbol: SYMBOL, type: 'LIMIT', ...order },
  });

export function setup() {
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const body = { email: `perf-${uuid()}@example.test`, password: 'correct horse battery staple' };
    withAuthBudget(() => request('POST', '/v1/auth/register', { body, phase: 'setup' }));
    const token = withAuthBudget(() =>
      request('POST', '/v1/auth/login', { body, phase: 'setup' }),
    ).json('accessToken');
    deposit(token, 'BTC', '100');
    deposit(token, 'USDT', '10000000');
    users.push(token);
  }
  // Seed a two-sided book so crossing orders trade from the first second.
  users.forEach((token, i) => {
    placeLimit(token, { side: 'BUY', price: String(MID - 1 - i), quantity: '0.5' }, 'setup');
    placeLimit(token, { side: 'SELL', price: String(MID + 1 + i), quantity: '0.5' }, 'setup');
  });
  return { users };
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const lots = () => (Math.floor(Math.random() * 9 + 1) / 1000).toFixed(3);

export function readDepth() {
  check(request('GET', `/v1/markets/${SYMBOL}/depth?limit=20`, { name: 'depth' }), {
    'depth 200': (r) => r.status === 200,
  });
}

export function readTicker() {
  check(request('GET', `/v1/markets/${SYMBOL}/ticker`, { name: 'ticker' }), {
    'ticker 200': (r) => r.status === 200,
  });
}

export function readTrades() {
  check(request('GET', `/v1/markets/${SYMBOL}/trades?limit=50`, { name: 'trades' }), {
    'trades 200': (r) => r.status === 200,
  });
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
