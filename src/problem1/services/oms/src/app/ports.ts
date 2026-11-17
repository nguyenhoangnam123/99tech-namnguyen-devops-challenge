import type {
  Amount,
  Asset,
  DoneReason,
  Fill,
  Journal,
  MatcherCommand,
  OrderFunds,
  OrderSpec,
  Reservation,
  Result,
} from '@exchange/core';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  uuid(): string;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string | undefined): Promise<boolean>;
}

export interface TokenIssuer {
  issue(userId: string): Promise<{ token: string; expiresIn: number }>;
}

export interface OrderRecord extends OrderFunds {
  readonly clientOrderId: string;
  readonly spec: OrderSpec;
  readonly reservation: Reservation;
  readonly doneReason: DoneReason | null;
  readonly cancelRequestedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewOrder {
  readonly id: string;
  readonly userId: string;
  readonly clientOrderId: string;
  readonly spec: OrderSpec;
  readonly reservation: Reservation;
  readonly createdAt: Date;
}

export type DepositStatus = 'CREDITED' | 'UNMATCHED';

export interface DepositRecord {
  readonly txId: string;
  readonly address: string;
  readonly asset: Asset;
  readonly amount: Amount;
  readonly userId: string | null;
  readonly status: DepositStatus;
}

// On conflict, `value` is the row that was already there.
export interface Inserted<T> {
  readonly inserted: boolean;
  readonly value: T;
}

export interface UserStore {
  create(user: {
    id: string;
    email: string;
    passwordHash: string;
  }): Promise<'CREATED' | 'EMAIL_TAKEN'>;
}

export interface LedgerStore {
  openUserAccounts(userId: string): Promise<void>;
  // Atomic; a user balance that would go negative fails the whole journal.
  post(journal: Journal): Promise<'POSTED' | 'INSUFFICIENT_FUNDS'>;
}

export interface OrderStore {
  insertIfAbsent(order: NewOrder): Promise<Inserted<OrderRecord>>;
  lockOwned(userId: string, orderId: string): Promise<OrderRecord | undefined>;
  // Locks in id order so concurrent settlements cannot deadlock.
  lockMany(orderIds: readonly string[]): Promise<Map<string, OrderRecord>>;
  markCancelRequested(orderId: string, at: Date): Promise<OrderRecord>;
  saveFunds(order: OrderFunds, at: Date, doneReason?: DoneReason): Promise<void>;
}

export interface FillStore {
  insert(fills: readonly Fill[]): Promise<void>;
}

export interface DepositStore {
  addressOwner(address: string): Promise<{ userId: string; asset: Asset } | undefined>;
  insertIfAbsent(deposit: DepositRecord, receivedAt: Date): Promise<Inserted<DepositRecord>>;
  addressFor(userId: string, asset: Asset, candidate: string): Promise<string>;
}

// Commands reach Kafka through the outbox, in the same transaction.
export interface CommandOutbox {
  enqueue(command: MatcherCommand): Promise<void>;
}

export interface Inbox {
  // False when this consumer already processed the message.
  remember(consumer: string, messageId: string): Promise<boolean>;
}

export interface TransactionPorts {
  readonly users: UserStore;
  readonly ledger: LedgerStore;
  readonly orders: OrderStore;
  readonly fills: FillStore;
  readonly deposits: DepositStore;
  readonly outbox: CommandOutbox;
  readonly inbox: Inbox;
}

export interface UnitOfWork {
  // Commits when the work returns ok, rolls back on an error result.
  run<T, E extends string>(
    work: (tx: TransactionPorts) => Promise<Result<T, E>>,
  ): Promise<Result<T, E>>;
  // For work with no business failure; only exceptions roll back.
  execute<T>(work: (tx: TransactionPorts) => Promise<T>): Promise<T>;
}

export interface BalanceView {
  readonly asset: Asset;
  readonly available: Amount;
  readonly held: Amount;
}

export interface OrderFilter {
  readonly symbol?: string | undefined;
  readonly openOnly: boolean;
  readonly limit: number;
}

export interface Credentials {
  readonly userId: string;
  readonly passwordHash: string;
}

export interface ReadModel {
  credentials(email: string): Promise<Credentials | undefined>;
  balances(userId: string): Promise<BalanceView[]>;
  order(userId: string, orderId: string): Promise<OrderRecord | undefined>;
  orders(userId: string, filter: OrderFilter): Promise<OrderRecord[]>;
  fills(userId: string, filter: { symbol?: string | undefined; limit: number }): Promise<Fill[]>;
}
