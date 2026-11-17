import {
  Lifecycle,
  closeServer,
  commonConfig,
  createKafka,
  createLogger,
  createProducer,
  createRegistry,
  kafkaConfig,
  listen,
  loadConfig,
  opsApp,
} from '@exchange/platform';
import { z } from 'zod';
import { Matcher } from './app/matcher.js';
import { MatcherWorker } from './adapters/kafka/matcher-worker.js';

// A fixed transactional id fences any older matcher still running.
const configSchema = z.object({
  ...commonConfig,
  ...kafkaConfig,
  MATCHER_TRANSACTIONAL_ID: z.string().min(1).default('matcher'),
});

async function main(): Promise<void> {
  const config = loadConfig(configSchema);
  const logger = createLogger('matcher', config.LOG_LEVEL);
  const registry = createRegistry('matcher');
  const lifecycle = new Lifecycle(logger);
  lifecycle.listen();

  const kafka = createKafka(config.KAFKA_BROKERS, 'matcher', logger);
  const producer = createProducer(kafka, config.MATCHER_TRANSACTIONAL_ID);
  await producer.connect();
  lifecycle.onShutdown('kafka-producer', () => producer.disconnect());

  const worker = new MatcherWorker(
    kafka,
    producer,
    new Matcher(),
    lifecycle.failFast('matcher'),
    logger,
    registry,
  );
  lifecycle.onShutdown('matcher', () => worker.stop());

  const server = await listen(
    opsApp(registry, () => Promise.resolve({ caughtUp: worker.isReady() })),
    config.HTTP_PORT,
  );
  lifecycle.onShutdown('ops-http', () => closeServer(server));
  await worker.start();
  logger.info('matcher started');
}

main().catch((error: unknown) => {
  console.error('matcher failed to start', error);
  process.exit(1);
});
