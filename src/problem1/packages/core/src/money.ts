// Fixed-point amount in units of 1e-18, the same scale as NUMERIC(36,18).
// Native bigint keeps arithmetic exact without a decimal library.
export type Amount = bigint;

export const SCALE = 18;
export const ZERO: Amount = 0n;

const UNIT = 10n ** BigInt(SCALE);
const DECIMAL = /^(-?)(0|[1-9]\d{0,17})(?:\.(\d{1,18}))?$/;

export function tryParseAmount(text: string): Amount | undefined {
  const match = DECIMAL.exec(text);
  if (!match) return undefined;
  const [, sign = '', whole = '0', fraction = ''] = match;
  const units = BigInt(whole) * UNIT + BigInt(fraction.padEnd(SCALE, '0'));
  return sign === '-' ? -units : units;
}

export function parseAmount(text: string): Amount {
  const amount = tryParseAmount(text);
  if (amount === undefined) throw new RangeError(`Not a decimal amount: ${text}`);
  return amount;
}

export function formatAmount(amount: Amount): string {
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / UNIT;
  const fraction = (absolute % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

// Rounds toward zero, which is down for the non-negative amounts we multiply.
export function mulDown(a: Amount, b: Amount): Amount {
  return (a * b) / UNIT;
}

export function divDown(a: Amount, b: Amount): Amount {
  return (a * UNIT) / b;
}

export function floorTo(amount: Amount, step: Amount): Amount {
  return amount - (amount % step);
}

export function isMultipleOf(amount: Amount, step: Amount): boolean {
  return amount % step === 0n;
}

export function minAmount(a: Amount, b: Amount): Amount {
  return a < b ? a : b;
}
