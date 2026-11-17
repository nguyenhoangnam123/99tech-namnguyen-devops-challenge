import { randomBytes, scrypt, type ScryptOptions, timingSafeEqual } from 'node:crypto';
import { Bounded } from '@exchange/platform';
import type { PasswordHasher } from '../../app/ports.js';

// OWASP-equivalent scrypt cost with 16 MiB per hash instead of 128 MiB.
const COST = { N: 2 ** 14, r: 8, p: 5, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export class ScryptPasswordHasher implements PasswordHasher {
  // Two hashes at a time per process; the rest queue briefly or get a 503.
  private readonly slots = new Bounded(2, 32);
  private readonly decoy = this.hash('decoy-password-for-unknown-users');

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await this.slots.run(() => derive(password, salt, COST));
    return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join(
      '$',
    );
  }

  // Unknown users verify against a decoy so both paths cost the same.
  async verify(password: string, hash: string | undefined): Promise<boolean> {
    const [scheme, n, r, p, salt, key] = (hash ?? (await this.decoy)).split('$');
    if (scheme !== 'scrypt' || !salt || !key) return false;
    const expected = Buffer.from(key, 'base64');
    const options = { N: Number(n), r: Number(r), p: Number(p), maxmem: COST.maxmem };
    const actual = await this.slots.run(() =>
      derive(password, Buffer.from(salt, 'base64'), options),
    );
    return timingSafeEqual(actual, expected) && hash !== undefined;
  }
}
