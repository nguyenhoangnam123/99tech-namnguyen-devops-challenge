import type { Redis } from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';

export interface RateLimitConfig {
  readonly authPerIpPerMinute: number;
  readonly loginsPerAccountPer15Minutes: number;
  readonly ordersPerSecond: number;
}

// Per IP stops floods; per account stops slow guessing from many IPs.
// Redis-backed; a Redis outage falls back to per-process memory.
export class RateLimits {
  private readonly authByIp: RateLimiterRedis;
  private readonly loginFailures: RateLimiterRedis;
  private readonly orders: RateLimiterRedis;

  constructor(
    redis: Redis,
    private readonly config: RateLimitConfig,
  ) {
    this.authByIp = limiter(redis, 'rl:auth-ip', config.authPerIpPerMinute, 60);
    this.loginFailures = limiter(
      redis,
      'rl:login-fail',
      config.loginsPerAccountPer15Minutes,
      15 * 60,
    );
    this.orders = limiter(redis, 'rl:orders', config.ordersPerSecond, 1);
  }

  allowRegister(clientIp: string): Promise<boolean> {
    return consume(this.authByIp, clientIp);
  }

  // Only failures count against the account; a success clears them.
  async allowLogin(clientIp: string, email: string): Promise<boolean> {
    if (!(await consume(this.authByIp, clientIp))) return false;
    const failures = await this.loginFailures.get(email.toLowerCase()).catch(() => null);
    return (failures?.consumedPoints ?? 0) < this.config.loginsPerAccountPer15Minutes;
  }

  async recordLogin(email: string, succeeded: boolean): Promise<void> {
    const key = email.toLowerCase();
    if (succeeded) await this.loginFailures.delete(key);
    else await this.loginFailures.penalty(key, 1);
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
