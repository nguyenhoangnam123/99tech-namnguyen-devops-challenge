import { createServer, type Server } from 'node:http';
import { route, type AppConfig } from './app.js';

export type Log = (fields: Record<string, unknown>) => void;

export function createHttpServer(config: AppConfig, log: Log): Server {
  const server = createServer((req, res) => {
    const started = performance.now();
    const url = parseUrl(req.url);
    const { status, body } = url
      ? route(config, { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams })
      : { status: 400, body: { error: 'bad request' } };
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
    // Health checks arrive every few seconds; logging them hides real traffic.
    if (url?.pathname !== '/healthz') {
      const ms = Math.round(performance.now() - started);
      log({ msg: 'request', method: req.method, path: url?.pathname, status, ms });
    }
  });
  // Longer than the ALB's 60 s idle timeout, so the ALB always closes
  // an idle connection first and never reuses one the server dropped.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}

function parseUrl(raw: string | undefined): URL | undefined {
  try {
    return new URL(raw ?? '/', 'http://localhost');
  } catch {
    return undefined;
  }
}
