import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Principal, SecurityHandler, SecurityRequest } from '@exchange/platform';
import type { JwtTokens } from '../crypto/tokens.js';

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

const header = (request: SecurityRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export function bearerAuth(tokens: JwtTokens): SecurityHandler {
  return async (request): Promise<Principal | undefined> => {
    const match = /^Bearer (\S+)$/.exec(header(request, 'authorization') ?? '');
    const userId = match?.[1] ? await tokens.verify(match[1]) : undefined;
    return userId ? { subject: userId, kind: 'user' } : undefined;
  };
}

// HMAC over timestamp and raw body; the timestamp bounds replays.
export function custodySignature(secret: string, now: () => number = Date.now): SecurityHandler {
  return (request): Promise<Principal | undefined> => {
    const timestamp = header(request, 'x-custody-timestamp') ?? '';
    const signature = header(request, 'x-custody-signature') ?? '';
    const sentAt = Number(timestamp);
    if (!/^\d{13}$/.test(timestamp) || Math.abs(now() - sentAt) > REPLAY_WINDOW_MS)
      return Promise.resolve(undefined);
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(request.rawBody)
      .digest();
    const actual = Buffer.from(signature, 'hex');
    const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
    return Promise.resolve(valid ? { subject: 'custody', kind: 'service' } : undefined);
  };
}
