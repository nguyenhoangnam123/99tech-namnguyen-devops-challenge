import { describe, expect, it } from 'vitest';
import {
  floorTo,
  formatAmount,
  isMultipleOf,
  mulDown,
  parseAmount,
  tryParseAmount,
} from '../src/money.js';

describe('money', () => {
  it.each([
    ['0', '0'],
    ['1', '1'],
    ['1.50', '1.5'],
    ['0.000000000000000001', '0.000000000000000001'],
    ['999999999999999999.999999999999999999', '999999999999999999.999999999999999999'],
    ['-2.25', '-2.25'],
    ['42.000000000000000000', '42'],
  ])('round-trips %s as %s', (text, canonical) => {
    expect(formatAmount(parseAmount(text))).toBe(canonical);
  });

  it.each([
    '',
    '01',
    '1.',
    '.5',
    '1e3',
    'NaN',
    '1.0000000000000000001',
    '1000000000000000000',
    ' 1',
  ])('rejects %j', (text) => {
    expect(tryParseAmount(text)).toBeUndefined();
  });

  it('multiplies exactly at scale and rounds the excess down', () => {
    expect(formatAmount(mulDown(parseAmount('60000.01'), parseAmount('0.00001')))).toBe(
      '0.6000001',
    );
    expect(formatAmount(mulDown(parseAmount('0.000000000000000001'), parseAmount('0.5')))).toBe(
      '0',
    );
  });

  it('floors to a step and checks multiples', () => {
    expect(formatAmount(floorTo(parseAmount('1.23456'), parseAmount('0.001')))).toBe('1.234');
    expect(isMultipleOf(parseAmount('0.03'), parseAmount('0.01'))).toBe(true);
    expect(isMultipleOf(parseAmount('0.031'), parseAmount('0.01'))).toBe(false);
  });
});
