export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E extends string> {
  readonly ok: false;
  readonly error: E;
}

// Business outcomes are values; exceptions are reserved for broken invariants.
export type Result<T, E extends string> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export const err = <E extends string>(error: E): Err<E> => ({ ok: false, error });

export class InvariantViolation extends Error {
  override readonly name = 'InvariantViolation';
}
