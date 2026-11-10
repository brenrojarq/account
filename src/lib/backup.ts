import { isCurrency, isValidRateSnapshot, type Currency, type CurrencyRateSnapshot, type RateType } from './currency';
import type { Expense, FinanceData, Frequency, Income, SavingsGoal } from './finance';

export const BACKUP_MAX_BYTES = 10 * 1024 * 1024;
export const BACKUP_STORAGE_KEYS = {
  data: 'balance-finance-v1',
  preferences: 'balance-preferences-v1',
  buy: 'konten:exchange-rates:v1:buy',
  sell: 'konten:exchange-rates:v1:sell',
} as const;

export type BackupFinanceData = FinanceData & { legacyCurrencyReview?: string };
export interface BackupPreferences {
  currency?: Currency;
  rateType?: RateType;
  chart?: 'pie' | 'bar' | 'scatter';
  cards?: string[];
  showTransactions?: boolean;
  showGoals?: boolean;
  demo?: boolean;
}
export interface KontenBackup {
  app: 'KONTEN';
  schemaVersion: 1;
  exportedAt: string;
  data: BackupFinanceData;
  preferences: BackupPreferences;
  rates?: { buy?: CurrencyRateSnapshot; sell?: CurrencyRateSnapshot };
}

type BackupStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type JsonObject = Record<string, unknown>;

function invalid(field: string): never {
  throw new Error(`El respaldo contiene un valor inválido en «${field}».`);
}

function object(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(field);
  return value as JsonObject;
}

function text(value: unknown, field: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(field);
  return value;
}

function amount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(field);
  return value;
}

function calendarDate(value: unknown, field: string): string {
  const date = text(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) invalid(field);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) invalid(field);
  return date;
}

function timestamp(value: unknown, field: string): string {
  const date = text(value, field, 40);
  calendarDate(date.slice(0, 10), field);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(date)
    || !Number.isFinite(Date.parse(date))) invalid(field);
  return date;
}

function frequency(value: unknown, field: string): Frequency {
  if (value !== 'monthly' && value !== 'biweekly' && value !== 'once') invalid(field);
  return value;
}

/** Copy only documented rate fields, never arbitrary properties from an imported file. */
function snapshot(value: unknown, field: string): CurrencyRateSnapshot {
  if (!isValidRateSnapshot(value)) invalid(field);
  return {
    usd: value.usd, eur: value.eur, rateType: value.rateType, provider: value.provider,
    date: value.date, fetchedAt: value.fetchedAt,
    ...(value.dateKind !== undefined ? { dateKind: value.dateKind } : {}),
    ...(value.sourceUrl !== undefined ? { sourceUrl: value.sourceUrl } : {}),
  };
}

function currencyFields(value: JsonObject, field: string): { currency?: Currency; exchangeRate?: CurrencyRateSnapshot } {
  if (value.currency !== undefined && !isCurrency(value.currency)) invalid(`${field}.currency`);
  return {
    ...(isCurrency(value.currency) ? { currency: value.currency } : {}),
    ...(value.exchangeRate !== undefined ? { exchangeRate: snapshot(value.exchangeRate, `${field}.exchangeRate`) } : {}),
  };
}

function records<T>(value: unknown, field: string, parse: (entry: JsonObject, field: string) => T & { id: string }): T[] {
  if (!Array.isArray(value)) invalid(field);
  const ids = new Set<string>();
  return value.map((entry: unknown, index: number) => {
    const location = `${field}[${index + 1}]`;
    const record = parse(object(entry, location), location);
    if (ids.has(record.id)) invalid(`${location}.id (duplicado)`);
    ids.add(record.id);
    return record;
  });
}

function movement(value: JsonObject, field: string) {
  return {
    id: text(value.id, `${field}.id`, 200), name: text(value.name, `${field}.name`),
    amount: amount(value.amount, `${field}.amount`),
    category: text(value.category, `${field}.category`, 200),
    date: calendarDate(value.date, `${field}.date`), ...currencyFields(value, field),
  };
}

function financeData(value: unknown): BackupFinanceData {
  const data = object(value, 'data');
  const incomes = records<Income>(data.incomes, 'ingresos', (entry, field) => ({
    ...movement(entry, field), frequency: frequency(entry.frequency, `${field}.frequency`),
  }));
  const expenses = records<Expense>(data.expenses, 'egresos', (entry, field) => {
    if (entry.kind !== 'fixed' && entry.kind !== 'variable') invalid(`${field}.kind`);
    return { ...movement(entry, field), kind: entry.kind,
      ...(entry.frequency !== undefined ? { frequency: frequency(entry.frequency, `${field}.frequency`) } : {}),
    };
  });
  const goals = records<SavingsGoal>(data.goals, 'metas', (entry, field) => {
    if (entry.color !== undefined && (typeof entry.color !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(entry.color))) invalid(`${field}.color`);
    return {
      id: text(entry.id, `${field}.id`, 200), name: text(entry.name, `${field}.name`),
      target: amount(entry.target, `${field}.target`), saved: amount(entry.saved, `${field}.saved`),
      monthly: amount(entry.monthly, `${field}.monthly`), ...currencyFields(entry, field),
      ...(typeof entry.color === 'string' ? { color: entry.color } : {}),
    };
  });
  if (data.legacyCurrency !== undefined && !isCurrency(data.legacyCurrency)) invalid('data.legacyCurrency');
  if (data.savingsCurrency !== undefined && !isCurrency(data.savingsCurrency)) invalid('data.savingsCurrency');
  return {
    incomes, expenses, goals, savingsAmount: amount(data.savingsAmount, 'data.savingsAmount'),
    ...(isCurrency(data.legacyCurrency) ? { legacyCurrency: data.legacyCurrency } : {}),
    ...(isCurrency(data.savingsCurrency) ? { savingsCurrency: data.savingsCurrency } : {}),
    ...(data.savingsExchangeRate !== undefined ? { savingsExchangeRate: snapshot(data.savingsExchangeRate, 'data.savingsExchangeRate') } : {}),
    ...(data.legacyCurrencyReview !== undefined ? { legacyCurrencyReview: text(data.legacyCurrencyReview, 'data.legacyCurrencyReview', 50) } : {}),
  };
}

/** Keep the public settings allowlist; authentication/session values are never exported. */
function preferences(value: unknown): BackupPreferences {
  const input = object(value, 'preferences');
  const output: BackupPreferences = {};
  if (input.currency !== undefined) {
    if (!isCurrency(input.currency)) invalid('preferences.currency');
    output.currency = input.currency;
  }
  if (input.rateType !== undefined) {
    if (input.rateType !== 'buy' && input.rateType !== 'sell') invalid('preferences.rateType');
    output.rateType = input.rateType;
  }
  if (input.chart !== undefined) {
    if (input.chart !== 'pie' && input.chart !== 'bar' && input.chart !== 'scatter') invalid('preferences.chart');
    output.chart = input.chart;
  }
  if (input.cards !== undefined) {
    const cards = input.cards;
    if (!Array.isArray(cards) || cards.some(card => typeof card !== 'string' || !['income', 'fixed', 'savings', 'available'].includes(card))
      || new Set(cards).size !== cards.length) invalid('preferences.cards');
    output.cards = [...cards];
  }
  for (const key of ['showTransactions', 'showGoals', 'demo'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') invalid(`preferences.${key}`);
      output[key] = input[key];
    }
  }
  return output;
}

export function validateBackup(value: unknown): KontenBackup {
  const input = object(value, 'respaldo');
  if (input.app !== 'KONTEN') throw new Error('Este archivo no es un respaldo de KONTEN.');
  if (input.schemaVersion !== 1) throw new Error('La versión de este respaldo no es compatible con KONTEN.');
  const output: KontenBackup = {
    app: 'KONTEN', schemaVersion: 1, exportedAt: timestamp(input.exportedAt, 'exportedAt'),
    data: financeData(input.data), preferences: preferences(input.preferences),
  };
  if (input.rates !== undefined) {
    const rates = object(input.rates, 'rates');
    output.rates = {};
    for (const type of ['buy', 'sell'] as const) {
      if (rates[type] !== undefined) {
        const rate = snapshot(rates[type], `rates.${type}`);
        if (rate.rateType !== type) invalid(`rates.${type}.rateType`);
        output.rates[type] = rate;
      }
    }
  }
  return output;
}

/** Read exactly two known public rate keys; never enumerate the browser's storage. */
export function readBackupRates(storage: Pick<Storage, 'getItem'>): NonNullable<KontenBackup['rates']> {
  const rates: NonNullable<KontenBackup['rates']> = {};
  for (const type of ['buy', 'sell'] as const) {
    try {
      const saved: unknown = JSON.parse(storage.getItem(BACKUP_STORAGE_KEYS[type]) ?? 'null');
      if (isValidRateSnapshot(saved) && saved.rateType === type) rates[type] = snapshot(saved, `rates.${type}`);
    } catch { /* A damaged or unavailable public-rate cache is not financial data. */ }
  }
  return rates;
}

export function createBackup(data: BackupFinanceData, prefs: unknown, rates?: KontenBackup['rates'], now = new Date()): KontenBackup {
  return validateBackup({ app: 'KONTEN', schemaVersion: 1, exportedAt: now.toISOString(), data, preferences: prefs, ...(rates ? { rates } : {}) });
}

export function serializeBackup(backup: KontenBackup): string {
  return JSON.stringify(validateBackup(backup), null, 2);
}

export function parseBackup(json: string): KontenBackup {
  if (new TextEncoder().encode(json).byteLength > BACKUP_MAX_BYTES) throw new Error('El respaldo supera el límite de 10 MB.');
  let input: unknown;
  try { input = JSON.parse(json); } catch { throw new Error('No se pudo leer el archivo. Elegí un respaldo JSON de KONTEN válido.'); }
  return validateBackup(input);
}

/**
 * Synchronous replacement of the four known records. Stage and validate everything
 * before writing; restore previous values if a storage operation fails.
 */
export function restoreBackup(backup: unknown, storage: BackupStorage): void {
  const validated = validateBackup(backup);
  const next = [
    [BACKUP_STORAGE_KEYS.data, JSON.stringify(validated.data)],
    [BACKUP_STORAGE_KEYS.preferences, JSON.stringify(validated.preferences)],
    [BACKUP_STORAGE_KEYS.buy, validated.rates?.buy ? JSON.stringify(validated.rates.buy) : null],
    [BACKUP_STORAGE_KEYS.sell, validated.rates?.sell ? JSON.stringify(validated.rates.sell) : null],
  ] as const;
  let previous: { key: string; value: string | null }[];
  try { previous = next.map(([key]) => ({ key, value: storage.getItem(key) })); }
  catch { throw new Error('No se pudo acceder al almacenamiento del dispositivo. No se aplicó el respaldo.'); }
  try {
    for (const [key, value] of next) {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    }
  } catch {
    let restored = true;
    for (const { key, value } of [...previous].reverse()) {
      try {
        if (storage.getItem(key) === value) continue;
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
      } catch { restored = false; }
    }
    throw new Error(restored
      ? 'No se pudo guardar el respaldo. Se conservaron los datos anteriores; revisá el espacio y los permisos de este navegador.'
      : 'El almacenamiento falló y no se pudo deshacer toda la restauración. Conservá ambos respaldos y no cierres esta pantalla antes de guardarlos.');
  }
}

/** Account restores must never overwrite another, unconnected device workspace. */
export function restoreBackupRateCaches(backup: KontenBackup, storage: BackupStorage): void {
  const validated = validateBackup(backup);
  const previous = (['buy', 'sell'] as const).map(type => ({ type, value: storage.getItem(BACKUP_STORAGE_KEYS[type]) }));
  try {
    for (const { type } of previous) {
      const rate = validated.rates?.[type];
      if (rate) storage.setItem(BACKUP_STORAGE_KEYS[type], JSON.stringify(rate));
      else storage.removeItem(BACKUP_STORAGE_KEYS[type]);
    }
  } catch {
    let rolledBack = true;
    for (const { type, value } of previous) {
      try { if (value === null) storage.removeItem(BACKUP_STORAGE_KEYS[type]); else storage.setItem(BACKUP_STORAGE_KEYS[type], value); }
      catch { rolledBack = false; }
    }
    throw new Error(rolledBack ? 'No se pudieron guardar las referencias de cambio. No se aplicó el respaldo.' : 'El almacenamiento falló al restaurar las referencias de cambio. Conservá el respaldo para volver a intentarlo.');
  }
}
