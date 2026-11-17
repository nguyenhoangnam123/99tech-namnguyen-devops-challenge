import { fileURLToPath } from 'node:url';
import {
  Lifecycle,
  closeServer,
  booleanFlag,
  commonConfig,
  createHttpApp,
  createKafka,
  createLogger,
  createRegistry,
  kafkaConfig,
  listen,
  loadConfig,
} from '@exchange/platform';
import { z } from 'zod';
import { MarketData } from './app/market-data.js';
import { marketDataHandlers } from './adapters/http/handlers.js';
import { EventFeed } from './adapters/kafka/event-feed.js';
import { MarketStream } from './adapters/ws/market-stream.js';

const SPEC_PATH = fileURLToPath(
  new URL('../../../contracts/openapi/marketdata.yaml', import.meta.url),
);

const configSchema = z.object({
  ...commonConfig,
  ...kafkaConfig,
  VALIDATE_RESPONSES: booleanFlag.default(false),
  WS_MAX_CONNECTIONS: z.coerce.number().int().positive().default(5000),
  WS_TICK_MS: z.coerce.number().int().positive().default(100),
});

async function main(): Promise<void> {
  const config = loadConfig(configSchema);
  const logger = createLogger('marketdata', config.LOG_LEVEL);
  const registry = createRegistry('marketdata');
  const lifecycle = new Lifecycle(logger);
  lifecycle.listen();
  const now = (): number => Date.now();

  const marketData = new MarketData();
  const feed = new EventFeed(
    createKafka(config.KAFKA_BROKERS, 'marketdata', logger),
    marketData,
    lifecycle.failFast('event-feed'),
    registry,
  );
  const app = createHttpApp({
    specPath: SPEC_PATH,
    logger,
    registry,
    validateResponses: config.VALIDATE_RESPONSES,
    handlers: marketDataHandlers({ marketData, isCaughtUp: () => feed.isCaughtUp(), now }),
  });
  const server = await listen(app, config.HTTP_PORT);
  const stream = new MarketStream(
    marketData,
    {
      specPath: SPEC_PATH,
      path: '/v1/ws',
      maxConnections: config.WS_MAX_CONNECTIONS,
      depthLimit: 20,
      tickMs: config.WS_TICK_MS,
    },
    logger,
    now,
    registry,
  );
  stream.attach(server);

  lifecycle.onShutdown('http', () => closeServer(server));
  lifecycle.onShutdown('ws', () => stream.close());
  lifecycle.onShutdown('event-feed', () => feed.stop());
  await feed.start();
  logger.info('marketdata started');
}

main().catch((error: unknown) => {
  console.error('marketdata failed to start', error);
  process.exit(1);
});
