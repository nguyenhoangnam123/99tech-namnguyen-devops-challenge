// What the SLO runner reads from Mimir for one load window: CPU and memory
// per service, the async pipeline, the telemetry agent and the Docker VM.
import { setTimeout as sleep } from 'node:timers/promises';

const MIMIR = process.env.MIMIR_URL ?? 'http://127.0.0.1:19009/prometheus';
// The collector's docker_stats interval, deploy/otel/collector.yaml.
const SAMPLE_SECONDS = 5;

export const SERVICE_GROUPS = {
  Exchange: ['edge', 'oms-api', 'oms-relay', 'matcher', 'oms-settler', 'marketdata'],
  State: ['postgres', 'kafka', 'redis'],
  Telemetry: ['otel-collector', 'tempo', 'loki', 'mimir', 'grafana'],
  'Load generator': ['k6'],
};
export const SIGNALS = {
  spans: 'spans',
  metric_points: 'metric points',
  log_records: 'log records',
};

// Each part is optional except resources: a missing part is left out.
// One part at a time: Mimir refuses too many queries in flight.
export async function measure(end, seconds) {
  const resources = await resourcesOver(end, seconds).catch((error) => ({ error: error.message }));
  const optional = (part) =>
    part(end, seconds).catch((error) => console.warn(`${part.name}: ${error.message}`));
  const agent = await optional(agentOver);
  const pipeline = await optional(pipelineOver);
  const host = await optional(hostOver);
  return { resources, agent, pipeline, host };
}

// Duplicate series per container are collapsed before summing replicas.
// CPU comes from the cumulative counter: Docker's utilisation gauge is
// sampled one-shot and reads as a near-constant lifetime average.
async function resourcesOver(end, seconds) {
  const perService = (expression) =>
    `sum by (compose_service) (max by (compose_service, container_name) (${expression}))`;
  const cpuNs = 'container_cpu_usage_nanoseconds_total{compose_project="exchange"}';
  const memory = 'container_memory_usage_total_bytes{compose_project="exchange"}';
  // ns of CPU per second / 1e7 = % of one core.
  const cpuAvgQuery = `${perService(`increase(${cpuNs}[${seconds}s])`)} / ${seconds} / 1e7`;
  const cpuMaxQuery = `max_over_time((${perService(`rate(${cpuNs}[15s])`)} / 1e7)[${seconds}s:5s])`;
  const [cpuAvg, cpuMax, memAvg, memMax, samples] = await Promise.all([
    query(cpuAvgQuery, end),
    query(cpuMaxQuery, end),
    query(`avg_over_time(${perService(memory)}[${seconds}s:5s])`, end),
    query(`max_over_time(${perService(memory)}[${seconds}s:5s])`, end),
    query(`min by (compose_service) (count_over_time(${memory}[${seconds}s]))`, end),
  ]);
  // A stalled collector leaves gaps that make averages meaningless.
  const expected = seconds / SAMPLE_SECONDS;
  const sparse = SERVICE_GROUPS.Exchange.filter((s) => !(samples[s] >= expected * 0.8));
  if (sparse.length > 0) {
    const counts = sparse.map((s) => `${s} ${samples[s] ?? 0}/${expected}`).join(', ');
    throw new Error(`sparse container metrics: ${counts}`);
  }
  const services = Object.values(SERVICE_GROUPS).flat();
  return Object.fromEntries(
    services.map((s) => [
      s,
      { cpuAvg: cpuAvg[s], cpuMax: cpuMax[s], memAvg: memAvg[s], memMax: memMax[s] },
    ]),
  );
}

// What the collector took in and turned away, per signal. Refused data
// was lost; tracing off simply sends no spans.
async function agentOver(end, seconds) {
  const total = (outcome, signal) =>
    `sum(increase(otelcol_receiver_${outcome}_${signal}_total[${seconds}s]))`;
  const signals = await Promise.all(
    Object.keys(SIGNALS).map(async (signal) => {
      const [accepted, refused, failed] = await Promise.all(
        ['accepted', 'refused', 'failed'].map((outcome) => queryOne(total(outcome, signal), end)),
      );
      return [signal, { accepted, lost: (refused ?? 0) + (failed ?? 0) }];
    }),
  );
  return Object.fromEntries(signals);
}

// The async half of an order: how far the book and balances trail the API.
// Read-only scenarios send no commands, so their values are absent.
async function pipelineOver(end, seconds) {
  const p99 = (metric) =>
    `histogram_quantile(0.99, sum by (le) (increase(${metric}_bucket[${seconds}s])))`;
  const [toMatcherP99, toSettledP99, outboxBacklogMax] = await Promise.all([
    queryOne(p99('matcher_command_age_seconds'), end),
    queryOne(p99('settlement_lag_seconds'), end),
    queryOne(`max(max_over_time(outbox_backlog[${seconds}s]))`, end),
  ]);
  return { toMatcherP99, toSettledP99, outboxBacklogMax };
}

// Share of the window in which tasks waited on CPU, memory or IO across the
// whole Docker VM. Memory or IO stalls freeze every container at once.
async function hostOver(end, seconds) {
  const share = (metric) =>
    `increase(node_pressure_${metric}_seconds_total[${seconds}s]) / ${seconds}`;
  const [cpu, memory, memoryFull, io, ioFull, swapInPerSecond, minAvailableBytes] =
    await Promise.all([
      queryOne(share('cpu_waiting'), end),
      queryOne(share('memory_waiting'), end),
      queryOne(share('memory_stalled'), end),
      queryOne(share('io_waiting'), end),
      queryOne(share('io_stalled'), end),
      queryOne(`increase(node_vmstat_pswpin[${seconds}s]) / ${seconds}`, end),
      queryOne(`min_over_time(node_memory_MemAvailable_bytes[${seconds}s])`, end),
    ]);
  if (cpu === undefined) throw new Error('no node-exporter data');
  return { cpu, memory, memoryFull, io, ioFull, swapInPerSecond, minAvailableBytes };
}

async function queryOne(promql, time) {
  const value = Object.values(await query(promql, time))[0];
  return Number.isFinite(value) ? value : undefined;
}

// Mimir sheds load with 429 when its queue is full (an open dashboard
// refreshing is enough), so back off and retry instead of losing a part.
async function query(promql, time, attempt = 1) {
  const url = `${MIMIR}/api/v1/query?query=${encodeURIComponent(promql)}&time=${time}`;
  const response = await fetch(url);
  if (response.status === 429 && attempt < 6) {
    await sleep(attempt * 1_000);
    return query(promql, time, attempt + 1);
  }
  const body = await response.json();
  if (body.status !== 'success') throw new Error(`Mimir: ${body.error ?? 'query failed'}`);
  return Object.fromEntries(
    body.data.result.map((r) => [r.metric.compose_service, Number(r.value[1])]),
  );
}
