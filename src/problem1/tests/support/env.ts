import { readFileSync } from 'node:fs';

const deploy = new URL('../../deploy/', import.meta.url);

const readSecret = (name: string): string => readFileSync(new URL(`.secrets/${name}`, deploy), 'utf8').trim();

const postgresPassword = (): string => {
  const line = readFileSync(new URL('.env', deploy), 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('POSTGRES_PASSWORD='));
  return line?.split('=')[1] ?? '';
};

export const env = {
  baseUrl: process.env['EXCHANGE_URL'] ?? 'http://127.0.0.1:18080',
  databaseUrl:
    process.env['TEST_DATABASE_URL'] ??
    `postgres://exchange:${postgresPassword()}@127.0.0.1:${process.env['PG_PORT'] ?? '15432'}/exchange`,
  custodySecret: process.env['CUSTODY_SECRET'] ?? readSecret('custody-webhook-secret'),
  jwtPrivateKey: () => readSecret('jwt-private-key.pem'),
};
