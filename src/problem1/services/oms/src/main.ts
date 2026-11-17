import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DB } from '@exchange/contracts';
import {
  type Database,
  Lifecycle,
  closeServer,
  type Logger,
  type Registry,
  createConsumer,
  createDatabase,
  createHttpApp,
  createKafka,
  createLogger,
  createProducer,
  createRegistry,
  listen,
  loadConfig,
  opsApp,
} from '@exchange/platform';
import { Redis } from 'ioredis';
import { AccountService } from './app/accounts.js';
import { DepositService } from './app/deposits.js';
import { OrderService } from './app/orders.js';
import { SETTLER_CONSUMER, SettlementService } from './app/settlement.js';
import { ScryptPasswordHasher } from './adapters/crypto/passwords.js';
import { JwtTokens } from './adapters/crypto/tokens.js';
import { omsHandlers } from './adapters/http/handlers.js';
import { RateLimits } from './adapters/http/rate-limits.js';
import { bearerAuth, custodySignature } from './adapters/http/security.js';
import { OutboxRelay } from './adapters/kafka/outbox-relay.js';
import { SettlementConsumer } from './adapters/kafka/settlement-consumer.js';
import { PgReadModel } from './adapters/postgres/read-model.js';
import { PgUnitOfWork } from './adapters/postgres/unit-of-work.js';
import { type ApiConfig, type RelayConfig, type SettlerConfig, omsConfigSchema } from './config.js';

const SPEC_PATH = fileURLToPath(new URL('../../../contracts/openapi/oms.yaml', import.meta.url));
const clock = { now: () => new Date() };
const ids = { uuid: () => randomUUID() };

interface Runtime {
  readonly logger: Logger;
  readonly registry: Registry;
  readonly lifecycle: Lifecycle;
  readonly database: Database<DB>;
}

async function main(): Promise<void> {
  const config = loadConfig(omsConfigSchema);
  const logger = createLogger(`oms-${config.OMS_ROLE}`, config.LOG_LEVEL);
  const lifecycle = new Lifecycle(logger);
  lifecycle.listen();
  const database = createDatabase<DB>(
    {
      url: config.DATABASE_URL,
      poolSize: config.DATABASE_POOL_SIZE,
      applicationName: `oms-${config.OMS_ROLE}`,
    },
    logger,
  );
  lifecycle.onShutdown('postgres', () => database.close());
  const runtime: Runtime = {
    logger,
    registry: createRegistry(`oms-${config.OMS_ROLE}`),
    lifecycle,
    database,
  };

  if (config.OMS_ROLE === 'api') await startApi(config, runtime);
  if (config.OMS_ROLE === 'relay') await startRelay(config, runtime);
  if (config.OMS_ROLE === 'settler') await startSettler(config, runtime);
  logger.info({ role: config.OMS_ROLE }, 'oms started');
}

async function startApi(
  config: ApiConfig,
  { logger, registry, lifecycle, database }: Runtime,
): Promise<void> {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on('error', (error) => {
    logger.warn({ err: error }, 'redis error');
  });
  lifecycle.onShutdown('redis', async () => {
    await redis.quit();
  });
  const uow = new PgUnitOfWork(database.db);
  const read = new PgReadModel(database.db);
  const tokens = new JwtTokens(config.JWT_PRIVATE_KEY, config.JWT_TTL_SECONDS);
  const passwords = new ScryptPasswordHasher();

  const app = createHttpApp({
    specPath: SPEC_PATH,
    logger,
    registry,
    validateResponses: config.VALIDATE_RESPONSES,
    security: {
      bearerAuth: bearerAuth(tokens),
      custodySignature: custodySignature(config.CUSTODY_WEBHOOK_SECRET),
    },
    handlers: omsHandlers({
      accounts: new AccountService({ uow, read, passwords, tokens, ids, clock }),
      deposits: new DepositService(uow, clock),
      orders: new OrderService({ uow, read, ids, clock }),
      limits: new RateLimits(redis, {
        authPerIpPerMinute: config.AUTH_RATE_LIMIT_PER_MINUTE,
        loginsPerAccountPer15Minutes: config.LOGIN_ATTEMPTS_PER_15_MINUTES,
        ordersPerSecond: config.ORDER_RATE_LIMIT_PER_SECOND,
      }),
      readiness: async () => ({
        postgres: await succeeds(database.ping()),
        redis: await succeeds(redis.ping()),
      }),
    }),
  });
  const server = await listen(app, config.HTTP_PORT);
  lifecycle.onShutdown('http', () => closeServer(server));
}

async function startRelay(
  config: RelayConfig,
  { logger, registry, lifecycle, database }: Runtime,
): Promise<void> {
  const producer = createProducer(createKafka(config.KAFKA_BROKERS, 'oms-relay', logger));
  await producer.connect();
  lifecycle.onShutdown('kafka-producer', () => producer.disconnect());
  const relay = new OutboxRelay(
    database.db,
    producer,
    { batchSize: config.OUTBOX_BATCH_SIZE, idleWaitMs: config.OUTBOX_IDLE_WAIT_MS },
    logger,
    registry,
  );
  lifecycle.onShutdown('relay', () => {
    relay.stop();
    return Promise.resolve();
  });
  void relay.run().catch(lifecycle.failFast('relay'));
  await serveOps(config.HTTP_PORT, registry, lifecycle, async () => ({
    postgres: await succeeds(database.ping()),
  }));
}

async function startSettler(
  config: SettlerConfig,
  { logger, registry, lifecycle, database }: Runtime,
): Promise<void> {
  const consumer = createConsumer(createKafka(config.KAFKA_BROKERS, 'oms-settler', logger), {
    groupId: SETTLER_CONSUMER,
  });
  const settlement = new SettlementService(new PgUnitOfWork(database.db), clock);
  const worker = new SettlementConsumer(
    consumer,
    settlement,
    lifecycle.failFast('settler'),
    registry,
  );
  lifecycle.onShutdown('kafka-consumer', () => worker.stop());
  await worker.start();
  await serveOps(config.HTTP_PORT, registry, lifecycle, async () => ({
    postgres: await succeeds(database.ping()),
  }));
}

async function serveOps(
  port: number,
  registry: Registry,
  lifecycle: Lifecycle,
  readiness: () => Promise<Record<string, boolean>>,
): Promise<void> {
  const server = await listen(opsApp(registry, readiness), port);
  lifecycle.onShutdown('ops-http', () => closeServer(server));
}

const succeeds = (probe: Promise<unknown>): Promise<boolean> =>
  probe.then(
    () => true,
    () => false,
  );

main().catch((error: unknown) => {
  console.error('oms failed to start', error);
  process.exit(1);
});
