// 500 rps open-model load at the P1 target: p99 < 100 ms per request.
// Arrival rate is fixed, so a slow system cannot hide by slowing the client.
import { setupTraders } from './lib.js';

export {
  cancelOne,
  placeOrder,
  readBalances,
  readDepth,
  readOpenOrders,
  readTicker,
  readTrades,
} from './lib.js';

const DURATION = __ENV.DURATION || '2m';
// Same mix at a fraction of the rate, for shared CI runners.
const RATE_SCALE = Number(__ENV.RATE_SCALE || 1);

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

export function setup() {
  return setupTraders(40);
}
