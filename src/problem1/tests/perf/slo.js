// Runs one SLO scenario from slo/scenarios.json, chosen by SCENARIO.
// The catalog sets the load model, window, size and the thresholds.
import { sleep } from 'k6';
import * as actions from './lib.js';

export {
  cancelOne,
  placeOrder,
  readBalances,
  readFills,
  readOpenOrders,
  readTicker,
  readTrades,
} from './lib.js';

const catalog = JSON.parse(open('./slo/scenarios.json'));
const spec = catalog.scenarios.find((scenario) => scenario.id === __ENV.SCENARIO);
if (!spec) throw new Error(`Unknown scenario ${__ENV.SCENARIO}`);
const window = __ENV.WINDOW || spec.window;
// Same load before the window, unmeasured: JIT, pools and caches warm up.
const WARMUP_SECONDS = Number(__ENV.WARMUP_SECONDS || 15);

// VUs for 1 s responses at full rate, ready up front. Starting VUs mid-run
// drops iterations, so a slow spell would go unmeasured (coordinated omission).
const arrival = (rate, exec) => ({
  executor: 'constant-arrival-rate',
  rate,
  timeUnit: '1s',
  preAllocatedVUs: Math.max(5, rate),
  maxVUs: rate * 2,
  exec,
});

const executors = () =>
  spec.load.model === 'arrival'
    ? Object.entries(spec.load.rates).map(([exec, rate]) => [exec, arrival(rate, exec)])
    : [['traders', { executor: 'constant-vus', vus: spec.load.vus, exec: 'trader' }]];

const loadNames = () => executors().map(([name]) => name);

function scenarios() {
  return Object.fromEntries(
    executors().flatMap(([name, executor]) => [
      [
        `warmup_${name}`,
        {
          ...executor,
          duration: `${WARMUP_SECONDS}s`,
          gracefulStop: '0s',
          tags: { phase: 'warmup' },
        },
      ],
      [
        name,
        { ...executor, duration: window, startTime: `${WARMUP_SECONDS}s`, tags: { phase: 'load' } },
      ],
    ]),
  );
}

export const options = {
  setupTimeout: '10m',
  scenarios: scenarios(),
  // Every sample carries the catalog id, so Grafana can group by it.
  tags: { slo: spec.id },
  thresholds: {
    'http_req_duration{phase:load}': [`p(95)<=${spec.slo.p95Ms}`, `p(99)<=${spec.slo.p99Ms}`],
    'http_req_failed{phase:load}': [`rate<${spec.slo.errorRate}`],
    // Always pass; they make k6 report the load phase counts. Drops carry
    // the scenario name but not scenario tags, so they are counted per name.
    'http_reqs{phase:load}': ['count>=0'],
    ...Object.fromEntries(
      loadNames().map((name) => [`dropped_iterations{scenario:${name}}`, ['count>=0']]),
    ),
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const data = actions.setupTraders(spec.traders, spec.size.bookLevels);
  return { ...data, loadStartsAt: data.loadStartsAt + WARMUP_SECONDS * 1000 };
}

export function readDepth(data) {
  actions.readDepth(data, spec.size.depthLevels);
}

// A closed-loop trader: act, think, repeat.
export function trader(data) {
  actions[spec.load.action](data);
  sleep(spec.load.thinkMs / 1000);
}

// Setup data holds access tokens, so only its start time is written.
export function handleSummary(data) {
  const droppedInLoad = loadNames().reduce(
    (sum, name) => sum + (data.metrics[`dropped_iterations{scenario:${name}}`]?.values.count ?? 0),
    0,
  );
  const summary = {
    loadStartsAt: data.setup_data?.loadStartsAt,
    droppedInLoad,
    metrics: data.metrics,
  };
  return { [`/reports/slo/${spec.id}.json`]: `${JSON.stringify(summary, null, 2)}\n` };
}
