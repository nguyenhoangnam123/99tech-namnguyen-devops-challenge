import { booleanFlag, commonConfig, kafkaConfig, postgresConfig } from '@exchange/platform';
import { z } from 'zod';

const shared = { ...commonConfig, ...postgresConfig };

// One image, three roles; each role validates only what it needs.
export const omsConfigSchema = z.discriminatedUnion('OMS_ROLE', [
  z.object({
    ...shared,
    OMS_ROLE: z.literal('api'),
    REDIS_URL: z.url(),
    JWT_PRIVATE_KEY: z.string().includes('PRIVATE KEY'),
    JWT_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    CUSTODY_WEBHOOK_SECRET: z.string().min(32),
    VALIDATE_RESPONSES: booleanFlag.default(false),
    AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
    LOGIN_ATTEMPTS_PER_15_MINUTES: z.coerce.number().int().positive().default(10),
    ORDER_RATE_LIMIT_PER_SECOND: z.coerce.number().int().positive().default(20),
  }),
  z.object({
    ...shared,
    ...kafkaConfig,
    OMS_ROLE: z.literal('relay'),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(500),
    OUTBOX_IDLE_WAIT_MS: z.coerce.number().int().positive().default(20),
  }),
  z.object({ ...shared, ...kafkaConfig, OMS_ROLE: z.literal('settler') }),
]);

export type OmsConfig = z.infer<typeof omsConfigSchema>;
export type ApiConfig = Extract<OmsConfig, { OMS_ROLE: 'api' }>;
export type RelayConfig = Extract<OmsConfig, { OMS_ROLE: 'relay' }>;
export type SettlerConfig = Extract<OmsConfig, { OMS_ROLE: 'settler' }>;
