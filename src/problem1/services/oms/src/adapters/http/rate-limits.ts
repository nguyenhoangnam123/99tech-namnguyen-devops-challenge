import type { Redis } from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';

export interface RateLimitConfig {
  readonly authPerIpPerMinute: number;
  readonly loginsPerAccountPer15Minutes: number;
  readonly ordersPerSecond: number;
}

// Per IP stops floods; per account stops guessing from many IPs.
// Redis-backed; a Redis outage falls back to per-process memory.
export class RateLimits {
  private readonly authByIp: RateLimiterRedis;
  private readonly loginAttempts: RateLimiterRedis;
  private readonly orders: RateLimiterRedis;

  constructor(redis: Redis, config: RateLimitConfig) {
    this.authByIp = limiter(redis, 'rl:auth-ip', config.authPerIpPerMinute, 60);
    this.loginAttempts = limiter(redis, 'rl:login', config.loginsPerAccountPer15Minutes, 15 * 60);
    this.orders = limiter(redis, 'rl:orders', config.ordersPerSecond, 1);
  }

  allowRegister(clientIp: string): Promise<boolean> {
    return consume(this.authByIp, clientIp);
  }

  // Every attempt is counted atomically before the password is checked,
  // so concurrent guesses cannot race past the limit. Success clears it.
  async allowLogin(
    clientIp: string,
    email: string,
  ): Promise<'OK' | 'RATE_LIMITED' | 'ACCOUNT_LOCKED'> {
    if (!(await consume(this.authByIp, clientIp))) return 'RATE_LIMITED';
    return (await consume(this.loginAttempts, email.toLowerCase())) ? 'OK' : 'ACCOUNT_LOCKED';
  }

  async loginSucceeded(email: string): Promise<void> {
    await this.loginAttempts.delete(email.toLowerCase());
  }

  allowOrder(userId: string): Promise<boolean> {
    return consume(this.orders, userId);
  }
}

function limiter(
  redis: Redis,
  keyPrefix: string,
  points: number,
  duration: number,
): RateLimiterRedis {
  return new RateLimiterRedis({
    storeClient: redis,
    keyPrefix,
    points,
    duration,
    insuranceLimiter: new RateLimiterMemory({ keyPrefix, points, duration }),
  });
}

async function consume(limiter: RateLimiterRedis, key: string): Promise<boolean> {
  try {
    await limiter.consume(key);
    return true;
  } catch (rejection) {
    if (rejection instanceof RateLimiterRes) return false;
    throw rejection;
  }
}
