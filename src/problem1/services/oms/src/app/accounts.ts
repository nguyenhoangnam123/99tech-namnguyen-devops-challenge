import { type Asset, type Result, err, ok } from '@exchange/core';
import type {
  BalanceView,
  Clock,
  IdGenerator,
  PasswordHasher,
  ReadModel,
  TokenIssuer,
  UnitOfWork,
} from './ports.js';

export interface AccountDeps {
  readonly uow: UnitOfWork;
  readonly read: ReadModel;
  readonly passwords: PasswordHasher;
  readonly tokens: TokenIssuer;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export class AccountService {
  constructor(private readonly deps: AccountDeps) {}

  async register(
    email: string,
    password: string,
  ): Promise<Result<{ userId: string }, 'EMAIL_TAKEN'>> {
    const userId = this.deps.ids.uuid();
    const passwordHash = await this.deps.passwords.hash(password);
    return this.deps.uow.run(async (tx) => {
      const created = await tx.users.create({ id: userId, email, passwordHash });
      if (created === 'EMAIL_TAKEN') return err('EMAIL_TAKEN');
      await tx.ledger.openUserAccounts(userId);
      return ok({ userId });
    });
  }

  // Verifies against a dummy hash for unknown emails so timing leaks nothing.
  async login(
    email: string,
    password: string,
  ): Promise<Result<{ token: string; expiresIn: number }, 'INVALID_CREDENTIALS'>> {
    const credentials = await this.deps.read.credentials(email);
    const valid = await this.deps.passwords.verify(password, credentials?.passwordHash);
    if (!credentials || !valid) return err('INVALID_CREDENTIALS');
    return ok(await this.deps.tokens.issue(credentials.userId));
  }

  balances(userId: string): Promise<BalanceView[]> {
    return this.deps.read.balances(userId);
  }

  depositAddress(userId: string, asset: Asset): Promise<string> {
    const candidate = `${asset.toLowerCase()}1${this.deps.ids.uuid().replaceAll('-', '')}`;
    return this.deps.uow.execute((tx) => tx.deposits.addressFor(userId, asset, candidate));
  }
}
