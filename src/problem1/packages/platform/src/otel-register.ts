// Loaded with `node --import @exchange/platform/otel-register` before the app.
// Disabled means no ESM hook and no SDK import: near-zero cost.
import { register } from 'node:module';

if (process.env.OTEL_SDK_DISABLED !== 'true') {
  // SDK first, hook second: the SDK's own modules need no wrapping.
  const { startTelemetry } = await import('./otel-sdk.js');
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  startTelemetry();
}
