import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { CurrencyRateSnapshot } from '../src/lib/currency';

const FINANCE_KEY = 'balance-finance-v1';
const PREF_KEY = 'balance-preferences-v1';
const SELL_KEY = 'konten:exchange-rates:v1:sell';
const BUY_KEY = 'konten:exchange-rates:v1:buy';
const BAC_URL = 'https://www.sucursalelectronica.com/exchangerate/showXmlExchangeRate.do';
const UNRELATED_KEY = 'konten-test-unrelated-session';

// Round, deliberately synthetic fixtures. These are not current BAC rates.
const capturedRate: CurrencyRateSnapshot = {
  usd: 40, eur: 50, rateType: 'sell', provider: 'manual', date: '2026-11-07',
  fetchedAt: '2026-11-07T17:00:00.000Z', dateKind: 'effective',
};
const sellCache = { ...capturedRate, usd: 41, eur: 51 };
const buyCache = { ...capturedRate, usd: 39, eur: 49, rateType: 'buy' };
const sourceData = {
  legacyCurrency: 'USD', savingsAmount: 300, savingsCurrency: 'USD', savingsExchangeRate: capturedRate,
  incomes: [{ id: 'salary', name: 'Salario en dólares', amount: 3000, currency: 'USD', frequency: 'monthly', category: 'Salario', date: '2026-11-01', exchangeRate: capturedRate }],
  expenses: [
    { id: 'rent', name: 'Alquiler en córdobas', amount: 8000, currency: 'NIO', kind: 'fixed', frequency: 'monthly', category: 'Vivienda', date: '2026-11-01', exchangeRate: capturedRate },
    { id: 'euros', name: 'Compra en euros', amount: 50, currency: 'EUR', kind: 'variable', category: 'Otros', date: '2026-11-04', exchangeRate: capturedRate },
  ],
  goals: [{ id: 'trip', name: 'Viaje en euros', target: 1000, saved: 200.1234, monthly: 20, currency: 'EUR', color: '#087f46', exchangeRate: capturedRate }],
};
const sourcePrefs = {
  currency: 'NIO', rateType: 'sell', chart: 'bar', cards: ['income', 'fixed', 'savings', 'available'],
  showTransactions: true, showGoals: true, demo: false,
};
const destinationData = {
  incomes: [{ id: 'old-income', name: 'Ingreso sólo en computadora', amount: 100, currency: 'EUR', frequency: 'once', category: 'Otros', date: '2026-11-02' }],
  expenses: [], goals: [], savingsAmount: 0, legacyCurrency: 'EUR', savingsCurrency: 'EUR',
};

interface IsolatedApp { page: Page; context: BrowserContext }

async function isolatedApp(browser: Browser, source: boolean): Promise<IsolatedApp> {
  const context = await browser.newContext({
    viewport: source ? { width: 390, height: 844 } : { width: 1440, height: 1100 },
    isMobile: source, hasTouch: source, locale: 'es-NI', timezoneId: 'America/Managua',
  });
  // No real request reaches the bank during a financial-data transfer test.
  await context.route(BAC_URL, route => route.abort('blockedbyclient'));
  await context.addInitScript(({ financeKey, prefKey, sellKey, buyKey, unrelatedKey, finance, prefs, sell, buy }) => {
    if (localStorage.getItem(financeKey) !== null) return;
    localStorage.setItem(financeKey, JSON.stringify(finance));
    localStorage.setItem(prefKey, JSON.stringify(prefs));
    localStorage.setItem(sellKey, JSON.stringify(sell));
    localStorage.setItem(buyKey, JSON.stringify(buy));
    localStorage.setItem(unrelatedKey, 'synthetic-session-value-do-not-export');
  }, {
    financeKey: FINANCE_KEY, prefKey: PREF_KEY, sellKey: SELL_KEY, buyKey: BUY_KEY, unrelatedKey: UNRELATED_KEY,
    finance: source ? sourceData : destinationData,
    prefs: source ? sourcePrefs : { ...sourcePrefs, currency: 'EUR', chart: 'pie' },
    sell: source ? sellCache : { ...sellCache, usd: 80, eur: 100 },
    buy: source ? buyCache : { ...buyCache, usd: 70, eur: 90 },
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2026-11-07T18:00:00.000Z'));
  await page.goto('/');
  await page.getByLabel('Mes del resumen').fill('2026-11');
  await expect(page.getByRole('combobox', { name: 'Moneda del resumen', exact: true })).toHaveValue(source ? 'NIO' : 'EUR');
  return { page, context };
}

async function knownRecords(page: Page) {
  return page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), [FINANCE_KEY, PREF_KEY, SELL_KEY, BUY_KEY, UNRELATED_KEY]);
}

async function openBackup(page: Page) {
  await page.getByRole('button', { name: 'Tipo de cambio', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Respaldo y traslado de datos', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

function available(page: Page) {
  return page.locator('.stat-card').filter({ hasText: 'Disponible para ti' }).locator('.stat-value');
}

test('traslada el respaldo real del celular a otra computadora sólo después de confirmar', async ({ browser }) => {
  const phone = await isolatedApp(browser, true);
  const computer = await isolatedApp(browser, false);
  try {
    await expect(available(phone.page)).toHaveText(/97,500\.00/);
    const phoneBefore = await knownRecords(phone.page);
    const computerBefore = await knownRecords(computer.page);
    const sourcePanel = await openBackup(phone.page);
    const downloadEvent = phone.page.waitForEvent('download');
    await sourcePanel.getByRole('button', { name: 'Descargar respaldo completo', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('konten-respaldo-2026-11-07.json');
    expect(await download.failure()).toBeNull();
    const path = await download.path();
    expect(path).toBeTruthy();
    const bytes = await readFile(path!);
    const exported = JSON.parse(bytes.toString('utf8'));
    expect(exported).toMatchObject({ app: 'KONTEN', schemaVersion: 1, data: sourceData, preferences: sourcePrefs, rates: { sell: sellCache, buy: buyCache } });
    expect(bytes.toString()).not.toContain('synthetic-session-value');
    expect(await knownRecords(phone.page)).toEqual(phoneBefore);
    expect(await knownRecords(computer.page)).toEqual(computerBefore);

    const destinationPanel = await openBackup(computer.page);
    await destinationPanel.getByLabel('Elegir respaldo para restaurar', { exact: true }).setInputFiles({ name: download.suggestedFilename(), mimeType: 'application/json', buffer: bytes });
    const preview = destinationPanel.locator('.backup-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Resumen en NIO');
    await expect(preview).toContainText('USD, NIO, EUR');
    await expect(preview.locator('dl')).toContainText(/Ingresos\s*1/);
    await expect(preview.locator('dl')).toContainText(/Egresos\s*2/);
    await expect(preview.locator('dl')).toContainText(/Metas de ahorro\s*1/);
    await expect(preview).toContainText('No combina registros.');
    await expect(preview.getByRole('button', { name: 'Descargar mis datos actuales antes de reemplazarlos', exact: true })).toBeEnabled();
    const restoreButton = preview.getByRole('button', { name: 'Restaurar este respaldo', exact: true });
    await expect(restoreButton).toBeDisabled();
    expect(await knownRecords(computer.page)).toEqual(computerBefore);
    await preview.getByRole('checkbox', { name: 'Confirmo que quiero reemplazar los datos de este navegador con este respaldo.', exact: true }).check();
    await expect(restoreButton).toBeEnabled();
    expect(await knownRecords(computer.page)).toEqual(computerBefore);
    await Promise.all([computer.page.waitForEvent('domcontentloaded'), restoreButton.click()]);

    await expect(computer.page.getByRole('combobox', { name: 'Moneda del resumen', exact: true })).toHaveValue('NIO');
    await computer.page.getByLabel('Mes del resumen').fill('2026-11');
    await expect(available(computer.page)).toHaveText(/97,500\.00/);
    const transferred = await knownRecords(computer.page);
    expect(JSON.parse(transferred[FINANCE_KEY]!)).toEqual(sourceData);
    expect(JSON.parse(transferred[PREF_KEY]!)).toEqual(sourcePrefs);
    expect(JSON.parse(transferred[SELL_KEY]!)).toEqual(sellCache);
    expect(JSON.parse(transferred[BUY_KEY]!)).toEqual(buyCache);
    expect(transferred[UNRELATED_KEY]).toBe(computerBefore[UNRELATED_KEY]);
    await computer.page.getByRole('combobox', { name: 'Moneda del resumen', exact: true }).selectOption('USD');
    await expect(available(computer.page)).toHaveText('$2,437.50');
    await computer.page.getByRole('combobox', { name: 'Moneda del resumen', exact: true }).selectOption('EUR');
    await expect(available(computer.page)).toHaveText('€1,950.00');
    expect(JSON.parse((await knownRecords(computer.page))[FINANCE_KEY]!)).toEqual(sourceData);
    expect(await knownRecords(phone.page)).toEqual(phoneBefore);
  } finally {
    await phone.context.close();
    await computer.context.close();
  }
});

test('un archivo malformado o de otra versión muestra error y conserva todos los datos', async ({ browser }) => {
  const computer = await isolatedApp(browser, false);
  try {
    const before = await knownRecords(computer.page);
    const panel = await openBackup(computer.page);
    const picker = panel.getByLabel('Elegir respaldo para restaurar', { exact: true });
    for (const [name, json, expected] of [
      ['malformado.json', '{ this is not valid JSON', /No se pudo leer el archivo/],
      ['version-futura.json', JSON.stringify({ app: 'KONTEN', schemaVersion: 99, data: sourceData }), /versión.*no es compatible/],
      ['moneda-invalida.json', JSON.stringify({ app: 'KONTEN', schemaVersion: 1, exportedAt: '2026-11-07T18:00:00.000Z', data: { ...sourceData, incomes: [{ ...sourceData.incomes[0], currency: 'XXX' }] }, preferences: sourcePrefs }), /valor inválido/],
    ] as const) {
      await picker.setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(json) });
      await expect(panel.getByRole('alert')).toHaveText(expected);
      await expect(panel.locator('.backup-preview')).toHaveCount(0);
      await expect(panel.getByRole('button', { name: 'Restaurar este respaldo', exact: true })).toHaveCount(0);
      expect(await knownRecords(computer.page)).toEqual(before);
    }
    await computer.page.getByRole('button', { name: 'Cerrar ventana', exact: true }).click();
    await expect(computer.page.getByRole('combobox', { name: 'Moneda del resumen', exact: true })).toHaveValue('EUR');
    await expect(available(computer.page)).toHaveText('€100.00');
  } finally {
    await computer.context.close();
  }
});
