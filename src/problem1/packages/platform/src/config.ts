import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Fails fast at boot with every invalid variable listed at once.
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  const parsed = schema.safeParse(withFileSecrets(env));
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new Error(`Invalid configuration: ${issues.join('; ')}`);
}

export const commonConfig = {
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HTTP_PORT: z.coerce.number().int().positive().default(3000),
};

export const kafkaConfig = {
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .transform((value) => value.split(',')),
};

export const postgresConfig = {
  DATABASE_URL: z.url(),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
};

export const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

// FOO_FILE=/run/secrets/foo sets FOO from that file, keeping secrets out of env.
function withFileSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...env };
  for (const [key, path] of Object.entries(env)) {
    if (key.endsWith('_FILE') && path)
      resolved[key.slice(0, -'_FILE'.length)] = readFileSync(path, 'utf8').trim();
  }
  return resolved;
}
