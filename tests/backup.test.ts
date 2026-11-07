import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_STORAGE_KEYS, createBackup, parseBackup, readBackupRates, restoreBackup, serializeBackup,
  type BackupFinanceData, type KontenBackup,
} from '../src/lib/backup.ts';
import type { CurrencyRateSnapshot } from '../src/lib/currency.ts';

// Synthetic financial records and rates only; no browser or user storage is read.
const rate: CurrencyRateSnapshot = {
  usd: 40, eur: 50, rateType: 'sell', provider: 'manual', date: '2026-11-07',
  fetchedAt: '2026-11-07T13:00:00.000Z', dateKind: 'effective',
};
const data: BackupFinanceData = {
  legacyCurrency: 'USD', savingsAmount: 123.4567, savingsCurrency: 'EUR', savingsExchangeRate: rate,
  incomes: [{ id: 'salary', name: 'Salario', amount: 1525.78, frequency: 'biweekly', date: '2026-01-01', category: 'Salario', currency: 'USD', exchangeRate: rate }],
  expenses: [
    { id: 'home', name: 'Alquiler', amount: 8000, kind: 'fixed', category: 'Vivienda', date: '2026-02-28', frequency: 'monthly', currency: 'NIO', exchangeRate: rate },
    { id: 'course', name: 'Curso', amount: 89.12345, kind: 'variable', category: 'Educación', date: '2026-11-06', currency: 'EUR' },
  ],
  goals: [{ id: 'trip', name: 'Viaje', target: 1000, saved: 215.45, monthly: 25, color: '#087f46', currency: 'EUR', exchangeRate: rate }],
};
const prefs = { currency: 'NIO', rateType: 'sell', chart: 'scatter', cards: ['available', 'income'], showGoals: false, showTransactions: true, demo: false };
const now = new Date('2026-11-07T16:30:00.000Z');

class MemoryStorage {
  values: Map<string, string>;
  writes = 0;
  reads: string[] = [];
  failAt = 0;
  failAfterMutation = false;
  constructor(entries: [string, string][] = []) { this.values = new Map(entries); }
  getItem(key: string) { this.reads.push(key); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.mutate(key, value); }
  removeItem(key: string) { this.mutate(key, null); }
  private mutate(key: string, value: string | null) {
    this.writes += 1;
    const fails = this.writes === this.failAt;
    if (fails && !this.failAfterMutation) throw new Error('Synthetic quota error');
    if (value === null) this.values.delete(key);
    else this.values.set(key, value);
    if (fails) throw new Error('Synthetic storage failure after mutation');
  }
}

function fixture(): KontenBackup {
  return createBackup(structuredClone(data), structuredClone(prefs), {
    sell: { ...rate }, buy: { ...rate, rateType: 'buy', provider: 'BAC', dateKind: 'observed', sourceUrl: 'https://example.com/public-rates' },
  }, now);
}

test('complete backup round trip preserves original USD, NIO, EUR amounts and captured rates', () => {
  const original = structuredClone(data);
  const backup = fixture();
  const restored = parseBackup(serializeBackup(backup));
  assert.deepEqual(restored, backup);
  assert.deepEqual(restored.data, original);
  assert.equal(restored.data.expenses[1].amount, 89.12345);
  assert.equal(restored.data.savingsAmount, 123.4567);
  assert.deepEqual(restored.data.savingsExchangeRate, rate);
  assert.equal(restored.rates?.buy?.rateType, 'buy');
  assert.equal(restored.rates?.buy?.dateKind, 'observed');
  assert.deepEqual(data, original, 'building a backup never mutates in-memory source data');
});

test('legacy records and their pending original-currency review are retained without converting', () => {
  const legacy: BackupFinanceData = {
    incomes: [{ id: 'old', name: 'Ingreso anterior', amount: 725.35, frequency: 'once', date: '2026-11-01', category: 'Otros' }],
    expenses: [], goals: [], savingsAmount: 50, legacyCurrencyReview: 'MXN',
  };
  const restored = parseBackup(serializeBackup(createBackup(legacy, {}, undefined, now)));
  assert.deepEqual(restored.data, legacy);
  assert.equal(restored.data.incomes[0].currency, undefined);
  assert.equal(restored.data.incomes[0].amount, 725.35);
  assert.equal(restored.data.legacyCurrencyReview, 'MXN');
});

test('only known settings, financial fields and two public rate cache keys are exported', () => {
  const withExtras = { ...data, session: 'do-not-export', incomes: [{ ...data.incomes[0], token: 'do-not-export' }] };
  const backup = createBackup(withExtras, { ...prefs, auth: 'do-not-export', session: 'do-not-export' }, undefined, now);
  assert.deepEqual(backup.preferences, prefs);
  assert.equal(JSON.stringify(backup).includes('do-not-export'), false);
  const storage = new MemoryStorage([
    [BACKUP_STORAGE_KEYS.sell, JSON.stringify(rate)],
    [BACKUP_STORAGE_KEYS.buy, JSON.stringify({ ...rate, rateType: 'buy', usd: 0 })],
    ['unrelated-auth-session', 'do-not-export'],
  ]);
  assert.deepEqual(readBackupRates(storage), { sell: rate });
  assert.deepEqual(storage.reads.sort(), [BACKUP_STORAGE_KEYS.buy, BACKUP_STORAGE_KEYS.sell].sort());
  assert.equal(storage.writes, 0);
});

test('invalid or malformed imports cannot change any storage', () => {
  const storage = new MemoryStorage([[BACKUP_STORAGE_KEYS.data, 'existing finance'], ['auth', 'unchanged']]);
  const before = [...storage.values];
  assert.throws(() => parseBackup('{bad JSON'), /JSON/);
  const invalid = [
    { ...fixture(), data: { ...data, incomes: null } },
    { ...fixture(), data: { ...data, savingsAmount: -1 } },
    { ...fixture(), data: { ...data, incomes: [{ ...data.incomes[0], amount: Infinity }] } },
    { ...fixture(), data: { ...data, incomes: [{ ...data.incomes[0], frequency: 'weekly' }] } },
    { ...fixture(), data: { ...data, incomes: [{ ...data.incomes[0], date: '2026-02-30' }] } },
    { ...fixture(), data: { ...data, incomes: [{ ...data.incomes[0], currency: 'MXN' }] } },
    { ...fixture(), data: { ...data, incomes: [data.incomes[0], data.incomes[0]] } },
    { ...fixture(), data: { ...data, expenses: [{ ...data.expenses[0], kind: 'monthly' }] } },
    { ...fixture(), data: { ...data, goals: [{ ...data.goals[0], color: 'url(javascript:alert(1))' }] } },
    { ...fixture(), data: { ...data, savingsExchangeRate: { ...rate, eur: 0 } } },
    { ...fixture(), preferences: { ...prefs, demo: 'false' } },
    { ...fixture(), preferences: { ...prefs, cards: ['unknown'] } },
    { ...fixture(), rates: { sell: { ...rate, rateType: 'buy' } } },
  ];
  for (const payload of invalid) {
    assert.throws(() => restoreBackup(payload, storage), /inválido/);
    assert.deepEqual([...storage.values], before);
    assert.equal(storage.writes, 0);
  }
});

test('unsupported app/version, invalid export date and oversized files are rejected', () => {
  assert.throws(() => parseBackup(JSON.stringify({ ...fixture(), schemaVersion: 2 })), /versión/);
  assert.throws(() => parseBackup(JSON.stringify({ ...fixture(), app: 'OTHER' })), /KONTEN/);
  assert.throws(() => parseBackup(JSON.stringify({ ...fixture(), exportedAt: '2026-02-30T10:00:00Z' })), /inválido/);
  assert.throws(() => parseBackup(' '.repeat(10 * 1024 * 1024 + 1)), /10 MB/);
});

test('successful restore replaces only four known records, preserving unrelated data', () => {
  const storage = new MemoryStorage([
    [BACKUP_STORAGE_KEYS.data, 'old'], [BACKUP_STORAGE_KEYS.preferences, 'old prefs'],
    [BACKUP_STORAGE_KEYS.buy, 'old rate'], ['auth', 'unchanged'],
  ]);
  const backup = createBackup(data, prefs, { sell: rate }, now);
  restoreBackup(backup, storage);
  assert.deepEqual(JSON.parse(storage.getItem(BACKUP_STORAGE_KEYS.data)!), data);
  assert.deepEqual(JSON.parse(storage.getItem(BACKUP_STORAGE_KEYS.preferences)!), prefs);
  assert.deepEqual(JSON.parse(storage.getItem(BACKUP_STORAGE_KEYS.sell)!), rate);
  assert.equal(storage.getItem(BACKUP_STORAGE_KEYS.buy), null, 'old rates absent from a backup do not leak into it');
  assert.equal(storage.getItem('auth'), 'unchanged');
});

test('write failures roll back every prior value, including missing keys and partially written keys', () => {
  for (const failAfterMutation of [false, true]) {
    for (const failAt of [1, 2, 3, 4]) {
      const entries: [string, string][] = [
        [BACKUP_STORAGE_KEYS.data, 'previous finance'], [BACKUP_STORAGE_KEYS.sell, 'previous sell rate'], ['other', 'untouched'],
      ];
      const storage = new MemoryStorage(entries);
      storage.failAt = failAt;
      storage.failAfterMutation = failAfterMutation;
      assert.throws(() => restoreBackup(fixture(), storage), /Se conservaron los datos anteriores/);
      assert.deepEqual(Object.fromEntries(storage.values), Object.fromEntries(entries));
    }
  }
});
