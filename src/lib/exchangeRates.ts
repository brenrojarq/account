import { isValidRateSnapshot, type CurrencyRateSnapshot, type RateType } from './currency';

/** Public XML feed used by the exchange-rate widget on BAC Nicaragua's website. */
export const BAC_RATES_URL = 'https://www.sucursalelectronica.com/exchangerate/showXmlExchangeRate.do';
export const BAC_SOURCE_URL = 'https://www.baccredomatic.com/es-ni';

const CACHE_PREFIX = 'konten:exchange-rates:v1:';
const REQUEST_TIMEOUT_MS = 10_000;

/** The feed does not expose a verified effective date; record when we observed it. */
function managuaDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('La fecha de consulta del tipo de cambio no es válida.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Managua', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function validateRateType(rateType: RateType): void {
  if (rateType !== 'buy' && rateType !== 'sell') {
    throw new Error('Seleccioná una tasa de compra o de venta.');
  }
}

function readPositiveRate(country: Element, field: string): number {
  const fields = country.getElementsByTagName(field);
  const text = fields.length === 1 ? fields[0].textContent?.trim() ?? '' : '';
  // BAC can use a decimal comma. Reject currency symbols, grouping and partial numbers.
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) {
    throw new Error('BAC devolvió un tipo de cambio inválido o incompleto.');
  }
  const value = Number(text.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('BAC devolvió un tipo de cambio inválido o incompleto.');
  }
  return value;
}

/** Parse only the Nicaragua record; both rates are córdobas per foreign currency. */
export function parseBacRates(
  xml: string,
  rateType: RateType,
  now: Date = new Date(),
): CurrencyRateSnapshot {
  validateRateType(rateType);
  if (typeof xml !== 'string' || !xml.trim() || /<!DOCTYPE/i.test(xml)) {
    throw new Error('BAC no devolvió un documento de tasas válido.');
  }
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) {
    throw new Error('No se pudo leer la respuesta de tipos de cambio de BAC.');
  }
  const countries = Array.from(document.getElementsByTagName('country')).filter(country => {
    const names = country.getElementsByTagName('name');
    return names.length === 1 && names[0].textContent?.trim() === 'Nicaragua';
  });
  if (countries.length !== 1) {
    throw new Error('BAC no incluyó una tasa válida para Nicaragua.');
  }
  const prefix = rateType === 'sell' ? 'saleRate' : 'buyRate';
  const snapshot: CurrencyRateSnapshot = {
    usd: readPositiveRate(countries[0], `${prefix}USD`),
    eur: readPositiveRate(countries[0], `${prefix}EUR`),
    rateType,
    provider: 'BAC',
    date: managuaDate(now),
    fetchedAt: now.toISOString(),
    dateKind: 'observed',
    sourceUrl: BAC_RATES_URL,
  };
  if (!isValidRateSnapshot(snapshot)) {
    throw new Error('BAC devolvió un tipo de cambio inválido o incompleto.');
  }
  return snapshot;
}

/** Read the public feed without bank credentials. Fail explicitly when BAC refuses access. */
export async function fetchBacRates(rateType: RateType, signal?: AbortSignal): Promise<CurrencyRateSnapshot> {
  validateRateType(rateType);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    let response: Response;
    let xml: string;
    try {
      response = await fetch(BAC_RATES_URL, {
        method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      });
      if (response.status === 403) {
        throw new Error('BAC no permite consultar sus tasas en este momento (403). Podés ingresar las tasas manualmente.');
      }
      if (!response.ok) {
        throw new Error(`BAC no pudo entregar sus tasas (HTTP ${response.status}). Podés ingresarlas manualmente.`);
      }
      xml = await response.text();
    } catch (error) {
      if (timedOut) throw new Error('BAC tardó demasiado en responder. Podés ingresar las tasas manualmente.');
      if (signal?.aborted) throw new Error('Se canceló la consulta del tipo de cambio.');
      if (error instanceof TypeError) {
        throw new Error('No se pudo conectar con BAC. Revisá tu conexión o ingresá las tasas manualmente.');
      }
      throw error;
    }
    return parseBacRates(xml, rateType);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Cache only validated public rate snapshots; unavailable browser storage is harmless. */
export function loadCachedRates(rateType: RateType): CurrencyRateSnapshot | null {
  try {
    validateRateType(rateType);
    const saved = localStorage.getItem(`${CACHE_PREFIX}${rateType}`);
    if (!saved) return null;
    const snapshot: unknown = JSON.parse(saved);
    return isValidRateSnapshot(snapshot) && snapshot.rateType === rateType ? snapshot : null;
  } catch {
    return null;
  }
}

export function saveCachedRates(snapshot: CurrencyRateSnapshot): void {
  if (!isValidRateSnapshot(snapshot)) return;
  try {
    localStorage.setItem(`${CACHE_PREFIX}${snapshot.rateType}`, JSON.stringify(snapshot));
  } catch {
    // Rates remain usable in memory when storage is full or disabled.
  }
}

export function isRateStale(snapshot: CurrencyRateSnapshot, now: Date = new Date()): boolean {
  if (!isValidRateSnapshot(snapshot)) return true;
  try {
    return snapshot.date !== managuaDate(now);
  } catch {
    return true;
  }
}
