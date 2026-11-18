import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http.js';

const logs: Record<string, unknown>[] = [];
const server = createHttpServer({ service: 'backend', version: 'v1', environment: 'test' }, (f) =>
  logs.push(f),
);
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('http server', () => {
  it('serves JSON that is never cached', async () => {
    const response = await fetch(`${base}/api/version`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ version: 'v1' });
  });

  it('logs requests but not health checks', async () => {
    logs.length = 0;
    await fetch(`${base}/healthz`);
    await fetch(`${base}/api/greeting?name=Bo`);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ path: '/api/greeting', status: 200 });
  });

  it('keeps idle connections open longer than the load balancer', () => {
    expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
  });
});
