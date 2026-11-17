// Runs the SLO catalog one scenario at a time. Latency comes from k6; CPU,
// memory, pipeline lag and VM stalls come from Mimir over the load window.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { measure } from './slo/mimir.mjs';
import { captured, consoleLine, render, toSeconds, verdictOf } from './slo/report.mjs';

const EDGE = process.env.EXCHANGE_URL ?? 'http://127.0.0.1:18080';
const OUT = 'reports/slo';
const REPORT = process.env.REPORT ?? `${OUT}/RESULTS.md`;
const COMPOSE = [
  ...['compose', '--env-file', 'deploy/.env', '-f', 'deploy/docker-compose.yml'],
  ...['--profile', 'obs'],
];

const catalog = JSON.parse(readFileSync('tests/perf/slo/scenarios.json', 'utf8'));
const wanted = process.env.SCENARIOS?.split(',');
const unknown = wanted?.filter((id) => !catalog.scenarios.some((s) => s.id === id)) ?? [];
if (unknown.length > 0) throw new Error(`Unknown scenarios: ${unknown.join(', ')}`);
const scenarios = catalog.scenarios.filter((s) => !wanted || wanted.includes(s.id));
// Passed by name only, so the value never shows in the process list.
const CUSTODY_SECRET = readFileSync('deploy/.secrets/custody-webhook-secret', 'utf8').trim();
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
// Untracked files count as changes too, unlike git describe --dirty.
const commit = `${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain') ? '-dirty' : ''}`;
const meta = {
  commit,
  telemetry: process.env.TELEMETRY === 'off' ? 'off' : `on, ${process.env.SAMPLE ?? '1'} sampled`,
  grafana: process.env.GRAFANA_URL ?? 'http://localhost:13000',
};

mkdirSync(OUT, { recursive: true });
const results = [];
for (const scenario of scenarios) {
  console.log(`\n== ${scenario.id}: ${scenario.title}`);
  const window = process.env.WINDOW ?? scenario.window;
  try {
    results.push({ scenario, window, ...(await run(scenario, window)) });
  } catch (error) {
    results.push({ scenario, window, failed: error.message });
  }
  // Written after every scenario, so a later failure keeps finished ones.
  writeFileSync(REPORT, render(results, meta));
  const json = JSON.stringify(captured(results, meta), null, 2);
  writeFileSync(REPORT.replace(/\.md$/, '.json'), `${json}\n`);
  console.log(consoleLine(results.at(-1)));
}
console.log(`\nWrote ${REPORT}`);
if (results.some((row) => verdictOf(row) !== 'met')) process.exitCode = 1;

async function run(scenario, window) {
  await untilEdgeReachesOms();
  const file = `${OUT}/${scenario.id}.json`;
  rmSync(file, { force: true });
  const k6 = spawnSync(
    'docker',
    [
      ...COMPOSE,
      'run',
      '--rm',
      ...['-e', `SCENARIO=${scenario.id}`, '-e', `WINDOW=${window}`, '-e', 'CUSTODY_SECRET'],
      'k6',
      'run',
      '--quiet',
      '--out',
      'opentelemetry',
      '/scripts/slo.js',
    ],
    { stdio: 'inherit', env: { ...process.env, CUSTODY_SECRET } },
  );
  // k6 exits 99 when thresholds fail; anything else means no valid result.
  if (k6.status !== 0 && k6.status !== 99) throw new Error(`k6 exited with ${k6.status}`);
  const summary = JSON.parse(readFileSync(file, 'utf8'));
  if (!summary.loadStartsAt) throw new Error('setup failed, see the k6 output');

  await sleep(15_000); // let the collector flush the window's last samples
  const seconds = toSeconds(window);
  const end = summary.loadStartsAt / 1000 + seconds;
  const span = { from: summary.loadStartsAt, to: end * 1000 };
  return { latency: latencyOf(summary, seconds), span, ...(await measure(end, seconds)) };
}

// nginx re-resolves upstreams every few seconds, so a recreated API
// container is briefly unreachable from the edge.
async function untilEdgeReachesOms() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${EDGE}/v1/auth/login`, { method: 'POST' }).catch(
      () => undefined,
    );
    if (response && response.status !== 502 && response.status !== 503) return;
    await sleep(1_000);
  }
  throw new Error('edge never reached oms');
}

function latencyOf({ metrics, droppedInLoad }, seconds) {
  const duration = metrics['http_req_duration{phase:load}'].values;
  return {
    p95: duration['p(95)'],
    p99: duration['p(99)'],
    errorRate: metrics['http_req_failed{phase:load}'].values.rate,
    dropped: droppedInLoad,
    requestRate: metrics['http_reqs{phase:load}'].values.count / seconds,
  };
}
