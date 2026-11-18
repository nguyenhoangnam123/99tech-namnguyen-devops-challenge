// Routing as a pure function: a request in, a response out.
// Sockets, clock and environment stay in http.ts and main.ts.
export interface AppConfig {
  service: string;
  version: string;
  environment: string;
}

export interface AppRequest {
  method: string;
  path: string;
  query: URLSearchParams;
}

export interface AppResponse {
  status: number;
  body: unknown;
}

const MAX_NAME = 64;

export function route(config: AppConfig, request: AppRequest): AppResponse {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return { status: 405, body: { error: 'method not allowed' } };
  }
  switch (request.path) {
    case '/healthz':
      return { status: 200, body: { status: 'ok' } };
    case '/api/version':
      return { status: 200, body: config };
    case '/api/greeting':
      return greeting(request.query.get('name'));
    default:
      return { status: 404, body: { error: 'not found' } };
  }
}

function greeting(name: string | null): AppResponse {
  const trimmed = name?.trim() ?? '';
  if (trimmed.length > MAX_NAME) {
    return { status: 400, body: { error: `name is longer than ${MAX_NAME} characters` } };
  }
  return { status: 200, body: { message: `Hello, ${trimmed || 'world'}!` } };
}
