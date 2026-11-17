// OpenTelemetry SDK for the services. Exporters, endpoint, sampler and
// service name come from the standard OTEL_* environment variables.
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { NodeSDK } from '@opentelemetry/sdk-node';

export function startTelemetry(): void {
  new NodeSDK({
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => isProbe(req.url) }),
      // One span per middleware layer adds cost and little insight.
      new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE] }),
      // Root-less queries are probes and the relay's idle polling.
      new PgInstrumentation({ requireParentSpan: true }),
      new IORedisInstrumentation({ requireParentSpan: true }),
      new PinoInstrumentation(),
    ],
  }).start();
}

// Health checks and scrapes would otherwise dominate the trace store.
function isProbe(url: string | undefined): boolean {
  return url === '/healthz' || url === '/readyz' || url === '/metrics';
}
