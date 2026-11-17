import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { closeServer, createHttpApp, createLogger, createRegistry, listen } from '../src/index.js';

const spec = (name: string): string =>
  fileURLToPath(new URL(`../../../contracts/openapi/${name}.yaml`, import.meta.url));

type Stub = (input: unknown) => Promise<{ status: number; body: unknown }>;

const servers: Awaited<ReturnType<typeof listen>>[] = [];

async function serve(specName: string, overrides: Record<string, Stub> = {}): Promise<string> {
  const fallback: Stub = () => Promise.resolve({ status: 200, body: { status: 'ok' } });
  const handlers = new Proxy(overrides, { get: (target, key: string) => target[key] ?? fallback });
  const app = createHttpApp({
    specPath: spec(specName),
    handlers: handlers as never,
    logger: createLogger('test', 'silent'),
    registry: createRegistry('test'),
    validateResponses: true,
  });
  const server = await listen(app, 0);
  servers.push(server);
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe('createHttpApp', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
  });

  it.each(['oms', 'marketdata'])('compiles the %s contract in the validator', async (name) => {
    const base = await serve(name);
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
  });

  it('turns request validation failures into problem responses', async () => {
    const base = await serve('marketdata');
    const response = await fetch(`${base}/v1/markets/DOGE-USDT/depth`);

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await response.json()).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('refuses a handler response that breaks the contract', async () => {
    const base = await serve('marketdata', {
      listMarkets: () => Promise.resolve({ status: 200, body: { markets: 'not-a-list' } }),
    });
    const response = await fetch(`${base}/v1/markets`);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'INTERNAL' });
  });
});
