import { describe, expect, it } from 'vitest';
import { route } from '../src/app.js';

const config = { service: 'backend', version: 'abc123', environment: 'test' };
const get = (path: string, query = '') =>
  route(config, { method: 'GET', path, query: new URLSearchParams(query) });

describe('route', () => {
  it('answers health checks', () => {
    expect(get('/healthz')).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('reports the deployed version', () => {
    expect(get('/api/version')).toEqual({ status: 200, body: config });
  });

  it('greets by name, trimmed, or the world by default', () => {
    expect(get('/api/greeting', 'name=%20Ada%20').body).toEqual({ message: 'Hello, Ada!' });
    expect(get('/api/greeting').body).toEqual({ message: 'Hello, world!' });
  });

  it('rejects names over 64 characters', () => {
    expect(get('/api/greeting', `name=${'a'.repeat(64)}`).status).toBe(200);
    expect(get('/api/greeting', `name=${'a'.repeat(65)}`).status).toBe(400);
  });

  it('returns 404 for unknown paths and 405 for writes', () => {
    expect(get('/nope').status).toBe(404);
    expect(
      route(config, { method: 'POST', path: '/healthz', query: new URLSearchParams() }).status,
    ).toBe(405);
  });
});
