// Grafana dashboards as code. Edit the panels below, run `make dashboards`,
// and Grafana reloads the JSON from deploy/grafana/dashboards within 10 seconds.
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'dashboards');
const MIMIR = { type: 'prometheus', uid: 'mimir' };
const TEMPO = { type: 'tempo', uid: 'tempo' };
const RATE = '$__rate_interval';

// Services label their own metrics; DNS-derived labels go stale on recreate.
const p = (q, metric, by, filter = '') =>
  `histogram_quantile(${q}, sum by (le${by ? `, ${by}` : ''}) (rate(${metric}_bucket${filter}[${RATE}])))`;
const perContainer = (expression) =>
  `sum by (compose_service) (max by (compose_service, container_name) (${expression}))`;
const project = '{compose_project="exchange"}';

const query = (expr, legend) => ({ datasource: MIMIR, expr, legendFormat: legend, refId: '' });

function timeseries(title, targets, { unit = 's', description, max, slo } = {}) {
  const steps = [{ color: 'green', value: null }];
  if (slo) steps.push({ color: 'red', value: slo });
  return {
    type: 'timeseries',
    title,
    description,
    datasource: MIMIR,
    targets,
    fieldConfig: {
      defaults: {
        unit,
        max,
        min: 0,
        thresholds: { mode: 'absolute', steps },
        custom: { thresholdsStyle: { mode: slo ? 'line+area' : 'off' }, fillOpacity: 0 },
      },
      overrides: [],
    },
    options: { tooltip: { mode: 'multi', sort: 'desc' }, legend: { displayMode: 'list' } },
  };
}

const serviceMap = {
  type: 'nodeGraph',
  title: 'Service map (from traces)',
  datasource: TEMPO,
  targets: [{ datasource: TEMPO, queryType: 'serviceMap', refId: 'A' }],
};

const row = (title) => ({ type: 'row', title, collapsed: false, panels: [] });

// Rows span the width; other panels flow two per line.
function layout(panels) {
  let x = 0;
  let y = 0;
  return panels.map((panel, id) => {
    const isRow = panel.type === 'row';
    if ((isRow && x > 0) || x === 24) {
      y += 8;
      x = 0;
    }
    const gridPos = isRow ? { x: 0, y, w: 24, h: 1 } : { x, y, w: 12, h: 8 };
    const targets = panel.targets?.map((t, i) => ({ ...t, refId: String.fromCharCode(65 + i) }));
    if (isRow) y += 1;
    else x += 12;
    return { ...panel, id: id + 1, gridPos, targets };
  });
}

function dashboard(uid, title, description, panels) {
  return {
    uid,
    title,
    description,
    tags: ['exchange'],
    timezone: 'browser',
    refresh: '10s',
    time: { from: 'now-30m', to: 'now' },
    schemaVersion: 41,
    editable: true,
    graphTooltip: 1,
    panels: layout(panels),
  };
}

const slo = dashboard(
  'exchange-slo',
  'Exchange: SLO and order pipeline',
  'Latency at the edge (k6) and inside each service, with SLO lines from the catalog.',
  [
    row('Edge, as the client sees it (k6 runs)'),
    timeseries(
      'Edge latency p95 / p99 by SLO scenario',
      [
        query(p(0.95, 'http_req_duration_milliseconds', 'slo', '{phase="load"}'), 'p95 {{slo}}'),
        query(p(0.99, 'http_req_duration_milliseconds', 'slo', '{phase="load"}'), 'p99 {{slo}}'),
      ],
      {
        unit: 'ms',
        slo: 100,
        description:
          'Red line: the P1 target, p99 100 ms. k6 buckets are coarse; exact numbers are in reports/slo.',
      },
    ),
    timeseries(
      'Edge throughput and error ratio',
      [
        query(`sum by (slo) (rate(http_reqs_total{phase="load"}[${RATE}]))`, '{{slo}} req/s'),
        query(
          `sum(rate(http_reqs_total{phase="load",expected_response="false"}[${RATE}])) / sum(rate(http_reqs_total{phase="load"}[${RATE}]))`,
          'error ratio',
        ),
      ],
      { unit: 'short' },
    ),
    row('Services, server side'),
    timeseries(
      'Request p99 by operation',
      [
        query(
          p(0.99, 'http_request_duration_seconds', 'service, operation'),
          '{{service}} {{operation}}',
        ),
      ],
      { slo: 0.1 },
    ),
    timeseries(
      'Requests by status',
      [
        query(
          `sum by (service, status) (rate(http_request_duration_seconds_count[${RATE}]))`,
          '{{service}} {{status}}',
        ),
      ],
      { unit: 'reqps' },
    ),
    row('Order pipeline: outbox, matcher, settlement'),
    timeseries(
      'Command age at the matcher, p50 / p99',
      [
        query(p(0.5, 'matcher_command_age_seconds', '', '{service="matcher"}'), 'p50'),
        query(p(0.99, 'matcher_command_age_seconds', '', '{service="matcher"}'), 'p99'),
      ],
      { description: 'Time from the API accepting an order to the matcher reading it.' },
    ),
    timeseries(
      'Settlement lag, p50 / p99',
      [
        query(p(0.5, 'settlement_lag_seconds', '', '{service="oms-settler"}'), 'p50'),
        query(p(0.99, 'settlement_lag_seconds', '', '{service="oms-settler"}'), 'p99'),
      ],
      { description: 'Time from a matcher event to its ledger journal.' },
    ),
    timeseries('Outbox backlog', [query('max(outbox_backlog{service="oms-relay"})', 'rows')], {
      unit: 'short',
    }),
    timeseries(
      'Pipeline throughput',
      [
        query(`sum(rate(outbox_published_total{service="oms-relay"}[${RATE}]))`, 'relay published'),
        query(
          `sum(rate(matcher_commands_total{service="matcher",mode="live"}[${RATE}]))`,
          'matcher commands',
        ),
        query(
          `sum(rate(settlement_batches_total{service="oms-settler"}[${RATE}]))`,
          'settled batches',
        ),
      ],
      { unit: 'ops' },
    ),
    row('Traces'),
    timeseries(
      'Span p99 by service (Tempo span metrics)',
      [
        query(
          p(
            0.99,
            'traces_spanmetrics_latency',
            'service',
            '{span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER"}',
          ),
          '{{service}}',
        ),
      ],
      { description: 'Only sampled traces count. Click a point to open exemplar traces.' },
    ),
    serviceMap,
  ],
);

const SIGNALS = [
  ['spans', 'spans'],
  ['metric_points', 'metric points'],
  ['log_records', 'log records'],
];
// memory_limiter.limit_mib in deploy/otel/collector.yaml.
const AGENT_LIMITER_BYTES = 200 * 2 ** 20;
const lostShare = (signal) => {
  const total = (outcome) => `sum(rate(otelcol_receiver_${outcome}_${signal}_total[${RATE}]))`;
  return `(${total('refused')} + ${total('failed')}) / (${total('accepted')} + ${total('refused')} + ${total('failed')})`;
};

const resources = dashboard(
  'exchange-resources',
  'Exchange: CPU and memory',
  'Per compose service from Docker stats, CPU as % of one core; then the agent itself.',
  [
    row('Containers'),
    timeseries(
      'CPU per service (% of one core)',
      [
        query(
          `${perContainer(`rate(container_cpu_usage_nanoseconds_total${project}[${RATE}])`)} / 1e7`,
          '{{compose_service}}',
        ),
      ],
      { unit: 'percent' },
    ),
    timeseries(
      'Memory per service',
      [query(perContainer(`container_memory_usage_total_bytes${project}`), '{{compose_service}}')],
      { unit: 'bytes' },
    ),
    timeseries(
      'Memory used of limit',
      [
        query(
          `max by (compose_service) (container_memory_usage_total_bytes${project} / container_memory_usage_limit_bytes${project})`,
          '{{compose_service}}',
        ),
      ],
      { unit: 'percentunit', max: 1, slo: 0.9 },
    ),
    timeseries(
      'Network received per service',
      [
        query(
          perContainer(`rate(container_network_io_usage_rx_bytes_total${project}[${RATE}])`),
          '{{compose_service}}',
        ),
      ],
      { unit: 'Bps' },
    ),
    row('Docker VM: shared by every container'),
    timeseries(
      'Stall time share (PSI)',
      [
        ['cpu_waiting', 'CPU'],
        ['memory_waiting', 'memory'],
        ['memory_stalled', 'memory, all tasks'],
        ['io_waiting', 'IO'],
        ['io_stalled', 'IO, all tasks'],
      ].map(([metric, label]) =>
        query(`rate(node_pressure_${metric}_seconds_total[${RATE}])`, label),
      ),
      {
        unit: 'percentunit',
        description: 'Time some (or all) tasks waited. Memory or IO stalls pause every service.',
      },
    ),
    timeseries(
      'Memory available and swap-in',
      [
        query('node_memory_MemAvailable_bytes', 'available'),
        query(`rate(node_vmstat_pswpin[${RATE}]) * 4096`, 'swap-in bytes/s'),
      ],
      { unit: 'bytes' },
    ),
    row('Telemetry agent: the OTel Collector'),
    timeseries(
      'Accepted per signal',
      SIGNALS.map(([signal, label]) =>
        query(`sum(rate(otelcol_receiver_accepted_${signal}_total[${RATE}]))`, label),
      ),
      { unit: 'cps' },
    ),
    timeseries(
      'Refused or failed share of intake',
      SIGNALS.map(([signal, label]) => query(lostShare(signal), label)),
      {
        unit: 'percentunit',
        slo: 0.001,
        description: 'Lost before export. The memory limiter refuses every signal at once.',
      },
    ),
    timeseries(
      'Exporter queue fill',
      [
        query(
          'max by (exporter) (otelcol_exporter_queue_size / otelcol_exporter_queue_capacity)',
          '{{exporter}}',
        ),
      ],
      { unit: 'percentunit', max: 1, slo: 0.8 },
    ),
    timeseries(
      'Agent memory against its limiter',
      [query('max(otelcol_process_memory_rss)', 'rss')],
      { unit: 'bytes', slo: AGENT_LIMITER_BYTES },
    ),
  ],
);

// Start clean, so a renamed or removed dashboard leaves no stale JSON behind.
mkdirSync(OUT, { recursive: true });
for (const file of readdirSync(OUT)) if (file.endsWith('.json')) unlinkSync(join(OUT, file));
for (const board of [slo, resources]) {
  writeFileSync(join(OUT, `${board.uid}.json`), `${JSON.stringify(board, null, 2)}\n`);
}
console.log(`Wrote 2 dashboards to ${OUT}`);
