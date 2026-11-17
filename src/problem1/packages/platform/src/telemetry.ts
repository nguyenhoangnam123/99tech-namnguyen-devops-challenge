import {
  type Attributes,
  type Span,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';

// W3C trace context as plain strings, to cross the outbox and Kafka.
// Every call is a no-op while the SDK is disabled.
export type TraceCarrier = Record<string, string>;

const tracer = trace.getTracer('exchange');

export function activeTraceCarrier(): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function carrierFromHeaders(
  headers: Readonly<Record<string, unknown>> | undefined,
): TraceCarrier {
  const carrier: TraceCarrier = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const first: unknown = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' || Buffer.isBuffer(first)) carrier[key] = first.toString();
  }
  return carrier;
}

// Runs async work as the active span, so database spans nest under it.
export function withSpan<T>(
  name: string,
  parent: TraceCarrier,
  work: () => Promise<T>,
  attributes: Attributes = {},
): Promise<T> {
  const parentContext = propagation.extract(context.active(), parent);
  return tracer.startActiveSpan(
    name,
    { kind: SpanKind.CONSUMER, attributes },
    parentContext,
    async (span) => {
      try {
        return await work();
      } catch (error) {
        fail(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export interface OpenSpan {
  // Context of this span, to pass downstream.
  readonly carrier: TraceCarrier;
  end(error?: unknown): void;
}

// For synchronous batch work whose spans close only after a commit.
export function startSpan(
  name: string,
  parent: TraceCarrier,
  attributes: Attributes = {},
): OpenSpan {
  const parentContext = propagation.extract(context.active(), parent);
  const span = tracer.startSpan(name, { kind: SpanKind.CONSUMER, attributes }, parentContext);
  const carrier: TraceCarrier = {};
  propagation.inject(trace.setSpan(parentContext, span), carrier);
  return {
    carrier,
    end: (error?: unknown) => {
      if (error !== undefined) fail(span, error);
      span.end();
    },
  };
}

function fail(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR });
}
