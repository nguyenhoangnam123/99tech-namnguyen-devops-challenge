// Loaded with `node --import @exchange/platform/otel-register` before the app.
// Exporters, endpoint and service name come from the standard OTEL_* env.
import { register } from 'node:module';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { NodeSDK } from '@opentelemetry/sdk-node';

// Disabled means no ESM hook and no SDK: zero overhead on the default stack.
if (process.env.OTEL_SDK_DISABLED !== 'true') {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  new NodeSDK({
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => isProbe(req.url) }),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
      new PinoInstrumentation(),
    ],
  }).start();
}

// Health checks and scrapes would otherwise dominate the trace store.
function isProbe(url: string | undefined): boolean {
  return url === '/healthz' || url === '/readyz' || url === '/metrics';
}
