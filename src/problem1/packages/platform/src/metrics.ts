import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export { Counter, Gauge, Histogram, Registry };

// Buckets sized around the 100 ms p99 objective.
// Up to 10 s, so a pipeline backlog stays measurable past its SLO.
export const LATENCY_BUCKETS = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function createRegistry(service: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  return registry;
}
