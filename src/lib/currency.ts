export type Currency = 'USD' | 'NIO' | 'EUR';
export type RateType = 'buy' | 'sell';

/** Exchange rates are expressed in córdobas (NIO) per USD or EUR. */
export interface CurrencyRateSnapshot {
  usd: number;
  eur: number;
  rateType: RateType;
  provider: 'BAC' | 'manual';
  date: string;
  fetchedAt: string;
  dateKind?: 'observed' | 'effective';
  sourceUrl?: string;
}

export const currencies: readonly Currency[] = ['USD', 'NIO', 'EUR'];

export const currencyLabels: Record<Currency, string> = {
  USD: 'Dólar estadounidense',
  NIO: 'Córdoba nicaragüense',
  EUR: 'Euro',
};

export const currencySymbols: Record<Currency, string> = { USD: '$', NIO: 'C$', EUR: '€' };

export function isCurrency(value: unknown): value is Currency {
  return value === 'USD' || value === 'NIO' || value === 'EUR';
}

/** Missing currency codes in older records inherit their original account currency. */
export function resolveCurrency(value: unknown, legacyCurrency: Currency = 'USD'): Currency {
  return isCurrency(value) ? value : legacyCurrency;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !isCalendarDate(value.slice(0, 10))) return false;
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  return hour < 24 && minute < 60 && second < 60 && Number.isFinite(Date.parse(value));
}

function isPositiveRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isValidRateSnapshot(value: unknown): value is CurrencyRateSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!isPositiveRate(candidate.usd) || !isPositiveRate(candidate.eur)
    || (candidate.rateType !== 'buy' && candidate.rateType !== 'sell')
    || (candidate.provider !== 'BAC' && candidate.provider !== 'manual')
    || !isCalendarDate(candidate.date) || !isTimestamp(candidate.fetchedAt)
    || (candidate.dateKind !== undefined && candidate.dateKind !== 'observed' && candidate.dateKind !== 'effective')) return false;

  if (candidate.sourceUrl !== undefined) {
    if (typeof candidate.sourceUrl !== 'string') return false;
    try {
      const source = new URL(candidate.sourceUrl);
      if (source.protocol !== 'https:' && source.protocol !== 'http:') return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Convert through NIO without rounding or changing the source amount/snapshot.
 * Round only after summing, or when displaying/exporting a monetary value.
 * A missing or invalid cross-currency rate remains explicitly unavailable.
 */
export function convertAmount(
  amount: number,
  from: Currency,
  to: Currency,
  snapshot?: CurrencyRateSnapshot | null,
): number | null {
  if (!Number.isFinite(amount) || !isCurrency(from) || !isCurrency(to)) return null;
  if (from === to) return amount;
  if (amount === 0) return 0;
  if (!isValidRateSnapshot(snapshot)) return null;

  const fromRate = from === 'NIO' ? 1 : from === 'USD' ? snapshot.usd : snapshot.eur;
  const toRate = to === 'NIO' ? 1 : to === 'USD' ? snapshot.usd : snapshot.eur;
  const converted = amount * (fromRate / toRate);
  return Number.isFinite(converted) ? converted : null;
}

/** Round monetary output to cents, with symmetric handling of signed amounts. */
export function roundCurrency(amount: number): number {
  const absolute = Math.abs(amount);
  return Math.sign(amount) * (Math.round((absolute + Number.EPSILON * absolute) * 100) / 100);
}
