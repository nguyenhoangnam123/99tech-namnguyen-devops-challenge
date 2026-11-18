import { createHttpServer, type Log } from './http.js';

const log: Log = (fields) =>
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...fields })}\n`);

const config = {
  service: 'backend',
  version: process.env.APP_VERSION ?? 'dev',
  environment: process.env.APP_ENV ?? 'local',
};
const port = Number(process.env.PORT ?? 8080);

const server = createHttpServer(config, log);
server.listen(port, () => log({ msg: 'listening', port, ...config }));

// The ALB drains an instance before it is stopped, so finish what is
// in flight, close idle keep-alive sockets and exit.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log({ msg: 'shutting down', signal });
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
