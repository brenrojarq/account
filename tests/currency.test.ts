import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertAmount, isValidRateSnapshot, resolveCurrency, roundCurrency,
  type CurrencyRateSnapshot,
} from '../src/lib/currency.ts';

// Deliberately synthetic rates, never defaults for the live application.
const rates: CurrencyRateSnapshot = {
  usd: 40, eur: 50, rateType: 'sell', provider: 'manual',
  date: '2026-11-06', fetchedAt: '2026-11-06T17:42:00.000Z', dateKind: 'effective',
};

test('converts dollars, córdobas, and euros through the same NIO reference', () => {
  assert.equal(convertAmount(100, 'USD', 'NIO', rates), 4000);
  assert.equal(convertAmount(4000, 'NIO', 'USD', rates), 100);
  assert.equal(convertAmount(100, 'EUR', 'NIO', rates), 5000);
  assert.equal(convertAmount(5000, 'NIO', 'EUR', rates), 100);
  assert.equal(convertAmount(100, 'USD', 'EUR', rates), 80);
  assert.equal(convertAmount(80, 'EUR', 'USD', rates), 100);
});

test('same-currency records remain usable without rates', () => {
  assert.equal(convertAmount(12.345, 'NIO', 'NIO'), 12.345);
  assert.equal(convertAmount(0, 'USD', 'USD'), 0);
  assert.equal(convertAmount(0, 'USD', 'NIO'), 0);
  assert.equal(convertAmount(-20, 'EUR', 'EUR'), -20);
  assert.equal(convertAmount(Number.NaN, 'USD', 'USD'), null);
  assert.equal(convertAmount(Number.POSITIVE_INFINITY, 'USD', 'NIO', rates), null);
});

test('missing or invalid cross-currency rates never produce an invented conversion', () => {
  assert.equal(convertAmount(100, 'USD', 'NIO'), null);
  assert.equal(convertAmount(100, 'EUR', 'USD', null), null);
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '40', undefined]) {
    for (const key of ['usd', 'eur']) {
      const invalid = { ...rates, [key]: value };
      assert.equal(isValidRateSnapshot(invalid), false, `${key}: ${String(value)}`);
      assert.equal(convertAmount(100, 'USD', 'EUR', invalid as CurrencyRateSnapshot), null);
    }
  }
});

test('rate snapshots validate calendar dates, timestamps, source, and provenance', () => {
  assert.equal(isValidRateSnapshot(rates), true);
  assert.equal(isValidRateSnapshot({ ...rates, date: '2024-02-29' }), true);
  assert.equal(isValidRateSnapshot({ ...rates, fetchedAt: '2026-11-06T11:42:00-06:00' }), true);
  assert.equal(isValidRateSnapshot({ ...rates, provider: 'BAC', dateKind: 'observed', sourceUrl: 'https://example.com/rates' }), true);
  for (const invalid of [
    null, {}, { ...rates, rateType: 'average' }, { ...rates, provider: 'unknown' },
    { ...rates, date: '2026-02-29' }, { ...rates, date: '2026-11-31' },
    { ...rates, date: '2026-00-01' }, { ...rates, fetchedAt: '2026-11-06' },
    { ...rates, fetchedAt: '2026-02-30T10:00:00Z' },
    { ...rates, fetchedAt: '2026-11-06T24:00:00Z' },
    { ...rates, dateKind: 'official' }, { ...rates, sourceUrl: 'javascript:alert(1)' },
  ]) assert.equal(isValidRateSnapshot(invalid), false, JSON.stringify(invalid));
});

test('conversion preserves precision through a USD/EUR round trip and rounds only output', () => {
  const snapshot = { ...rates, usd: 36.7, eur: 39.83 };
  const original = 7.13;
  const euros = convertAmount(original, 'USD', 'EUR', snapshot)!;
  assert.notEqual(euros, roundCurrency(euros));
  assert.ok(Math.abs(convertAmount(euros, 'EUR', 'USD', snapshot)! - original) < 1e-12);
  const unroundedTotal = convertAmount(0.01, 'USD', 'EUR', snapshot)! * 100;
  assert.equal(roundCurrency(unroundedTotal), 0.92);
  assert.equal(roundCurrency(1.005), 1.01);
  assert.equal(roundCurrency(-1.005), -1.01);
});

test('switching summary currency never changes an original record or its rate snapshot', () => {
  const snapshot = Object.freeze({ ...rates });
  const original = Object.freeze({ amount: 725.35, currency: 'USD' as const, exchangeRate: snapshot });
  const before = JSON.stringify(original);
  assert.equal(roundCurrency(convertAmount(original.amount, original.currency, 'NIO', snapshot)!), 29014);
  assert.equal(roundCurrency(convertAmount(original.amount, original.currency, 'EUR', snapshot)!), 580.28);
  assert.equal(convertAmount(original.amount, original.currency, 'USD', snapshot), 725.35);
  assert.equal(JSON.stringify(original), before);
});

test('older records inherit an explicitly supplied original account currency', () => {
  assert.equal(resolveCurrency(undefined, 'NIO'), 'NIO');
  assert.equal(resolveCurrency(null, 'EUR'), 'EUR');
  assert.equal(resolveCurrency('USD', 'NIO'), 'USD');
  assert.equal(resolveCurrency(undefined), 'USD');
});
