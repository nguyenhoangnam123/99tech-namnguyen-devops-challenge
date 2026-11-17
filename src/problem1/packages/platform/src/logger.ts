import { pino, type Logger } from 'pino';

export type { Logger };

const REDACTED_PATHS = [
  'password',
  '*.password',
  'accessToken',
  '*.accessToken',
  'headers.authorization',
  'headers["x-custody-signature"]',
];

export function createLogger(service: string, level: string): Logger {
  return pino({
    level,
    base: { service },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
