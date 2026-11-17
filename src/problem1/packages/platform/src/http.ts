import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { parse } from 'yaml';
import type { Logger } from './logger.js';
import { Histogram, LATENCY_BUCKETS, type Registry } from './metrics.js';

export interface Principal {
  readonly subject: string;
  readonly kind: 'user' | 'service';
}

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
}

type JsonOf<R> = R extends { content: { 'application/json': infer B } }
  ? B
  : R extends { content: { 'application/problem+json': infer P } }
    ? P
    : undefined;

type ParamsOf<Op, In extends string> = Op extends { parameters: infer P }
  ? In extends keyof P
    ? [NonNullable<P[In]>] extends [never]
      ? Record<string, never>
      : NonNullable<P[In]>
    : Record<string, never>
  : Record<string, never>;

type BodyOf<Op> = Op extends { requestBody: { content: { 'application/json': infer B } } }
  ? B
  : undefined;

// Handler input and output types are derived from the generated OpenAPI operation.
export interface OperationInput<Op> {
  readonly body: BodyOf<Op>;
  readonly path: ParamsOf<Op, 'path'>;
  readonly query: ParamsOf<Op, 'query'>;
  readonly principal: Principal | undefined;
  readonly clientIp: string;
  readonly requestId: string;
}

export type OperationResult<Op> = Op extends { responses: infer R }
  ? { [S in keyof R & number]: { readonly status: S; readonly body: JsonOf<R[S]> } }[keyof R &
      number]
  : never;

export type OperationHandler<Op> = (input: OperationInput<Op>) => Promise<OperationResult<Op>>;

export type OperationHandlers<Ops> = { readonly [K in keyof Ops]: OperationHandler<Ops[K]> };

export interface SecurityRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody: Buffer;
}

export type SecurityHandler = (request: SecurityRequest) => Promise<Principal | undefined>;

export interface HttpAppOptions<Ops> {
  readonly specPath: string;
  readonly handlers: OperationHandlers<Ops>;
  readonly security?: Readonly<Record<string, SecurityHandler>>;
  readonly logger: Logger;
  readonly registry: Registry;
  readonly validateResponses: boolean;
}

interface OpenApiDocument {
  readonly paths: Record<string, Partial<Record<HttpMethod, { operationId: string }>>>;
}

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
const METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

type ContextRequest = Request & { principal?: Principal; rawBody?: Buffer };

export function problem<S extends number>(
  status: S,
  code: string,
  detail?: string,
): { status: S; body: Problem } {
  const body: Problem = { type: 'about:blank', title: titleOf(status), status, code };
  return { status, body: detail === undefined ? body : { ...body, detail } };
}

// Routes come from the spec; a spec operation without a handler fails at boot.
export function createHttpApp<Ops>(options: HttpAppOptions<Ops>): express.Express {
  const spec = parse(readFileSync(options.specPath, 'utf8')) as OpenApiDocument;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, uniquelocal');
  app.use(observe(options.logger, options.registry));
  app.use(
    express.json({
      limit: '16kb',
      verify: (req, _res, buffer) => {
        (req as ContextRequest).rawBody = buffer;
      },
    }),
  );
  app.get('/metrics', async (_req, res) => {
    res.type(options.registry.contentType).send(await options.registry.metrics());
  });
  app.use(
    OpenApiValidator.middleware({
      apiSpec: structuredClone(spec) as never,
      validateRequests: { allowUnknownQueryParameters: false, coerceTypes: true },
      validateResponses: options.validateResponses,
      validateSecurity: { handlers: toValidatorHandlers(options.security ?? {}) },
      ignorePaths: /^\/metrics$/,
    }),
  );
  for (const route of routesOf(spec)) {
    const handler = (options.handlers as Record<string, OperationHandler<unknown>>)[
      route.operationId
    ];
    if (!handler) throw new Error(`No handler for operation ${route.operationId}`);
    app[route.method](route.path, invoke(route.operationId, handler));
  }
  app.use(errorHandler(options.logger));
  return app;
}

// Health and metrics for worker roles that serve no public API.
export function opsApp(
  registry: Registry,
  readiness: () => Promise<Record<string, boolean>>,
): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', async (_req, res) => {
    const checks = await readiness();
    const healthy = Object.values(checks).every(Boolean);
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'unavailable', checks });
  });
  app.get('/metrics', async (_req, res) => {
    res.type(registry.contentType).send(await registry.metrics());
  });
  return app;
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// Keep-alive above the proxy's idle timeout, or the proxy reuses closed sockets.
export function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      resolve(server);
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.requestTimeout = 10_000;
  });
}

function routesOf(
  spec: OpenApiDocument,
): { method: HttpMethod; path: string; operationId: string }[] {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const operation = item[method];
      if (!operation) return [];
      return [
        { method, path: path.replace(/\{(\w+)\}/g, ':$1'), operationId: operation.operationId },
      ];
    }),
  );
}

function invoke(operationId: string, handler: OperationHandler<unknown>) {
  return async (req: ContextRequest, res: Response): Promise<void> => {
    res.locals.operationId = operationId;
    const input = {
      body: req.body as unknown,
      path: req.params,
      query: req.query,
      principal: req.principal,
      clientIp: req.ip ?? 'unknown',
      requestId: String(res.locals.requestId),
    } as OperationInput<unknown>;
    const result = (await handler(input)) as { status: number; body: unknown };
    res
      .status(result.status)
      .type(result.status >= 400 ? 'application/problem+json' : 'application/json')
      .json(result.body);
  };
}

function toValidatorHandlers(security: Readonly<Record<string, SecurityHandler>>) {
  return Object.fromEntries(
    Object.entries(security).map(([scheme, authenticate]) => [
      scheme,
      async (req: ContextRequest): Promise<boolean> => {
        const principal = await authenticate({
          headers: req.headers,
          rawBody: req.rawBody ?? Buffer.alloc(0),
        });
        if (!principal) throw Object.assign(new Error('Unauthenticated'), { status: 401 });
        req.principal = principal;
        return true;
      },
    ]),
  );
}

function observe(logger: Logger, registry: Registry) {
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency by operation and status',
    labelNames: ['operation', 'method', 'status'],
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  });
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    const requestId = req.get('x-request-id') ?? randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const operation = String(res.locals.operationId ?? 'unmatched');
      duration.observe({ operation, method: req.method, status: res.statusCode }, seconds);
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'info' : 'debug';
      logger[level](
        {
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: seconds * 1000,
          operation,
        },
        'request',
      );
    });
    next();
  };
}

function errorHandler(logger: Logger) {
  return (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status = statusOf(error);
    if (status >= 500)
      logger.error({ err: error, requestId: res.locals.requestId }, 'request failed');
    const body =
      status >= 500 ? problem(status, codeOf(status)).body : clientProblem(status, error);
    res.status(status).type('application/problem+json').json(body);
  };
}

function clientProblem(status: number, error: unknown): Problem & { errors?: unknown[] } {
  const details = error as { message?: string; errors?: { path?: string; message?: string }[] };
  const body = problem(status, codeOf(status), details.message).body;
  if (!details.errors) return body;
  return { ...body, errors: details.errors.map(({ path, message }) => ({ path, message })) };
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

const CODES: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
};

const codeOf = (status: number): string => CODES[status] ?? 'INTERNAL';

const titleOf = (status: number): string =>
  (CODES[status] ?? 'INTERNAL').toLowerCase().replaceAll('_', ' ');
