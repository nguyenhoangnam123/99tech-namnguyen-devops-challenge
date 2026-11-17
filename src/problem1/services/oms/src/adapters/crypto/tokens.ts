import { createPrivateKey, createPublicKey, type KeyObject, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { TokenIssuer } from '../../app/ports.js';

const ISSUER = 'exchange-oms';
const AUDIENCE = 'exchange-api';

// EdDSA only: verification pins the algorithm, so alg=none or HS256 swaps fail.
export class JwtTokens implements TokenIssuer {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(
    privateKeyPem: string,
    private readonly ttlSeconds: number,
  ) {
    this.privateKey = createPrivateKey(privateKeyPem);
    this.publicKey = createPublicKey(this.privateKey);
    if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('JWT key must be Ed25519');
  }

  async issue(userId: string): Promise<{ token: string; expiresIn: number }> {
    const token = await new SignJWT()
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${String(this.ttlSeconds)}s`)
      .setJti(randomUUID())
      .sign(this.privateKey);
    return { token, expiresIn: this.ttlSeconds };
  }

  async verify(token: string): Promise<string | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: ['EdDSA'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      return payload.sub;
    } catch {
      return undefined;
    }
  }
}
