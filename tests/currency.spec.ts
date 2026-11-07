import { test, expect, type Download, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as XLSX from 'xlsx';
import type { CurrencyRateSnapshot } from '../src/lib/currency';

const FINANCE_KEY = 'balance-finance-v1';
const PREF_KEY = 'balance-preferences-v1';
const RATE_KEY = 'konten:exchange-rates:v1:sell';
const BAC_URL = 'https://www.sucursalelectronica.com/exchangerate/showXmlExchangeRate.do';

// Deliberately round test fixtures, not claims about BAC's current live rates.
const capturedRates: CurrencyRateSnapshot = {
  usd: 40, eur: 50, rateType: 'sell', provider: 'manual',
  date: '2026-11-07', dateKind: 'effective', fetchedAt: '2026-11-07T18:00:00.000Z',
};

const emptyData = { incomes: [], expenses: [], goals: [], savingsAmount: 0, legacyCurrency: 'USD', savingsCurrency: 'USD' };
const mixedData = {
  incomes: [{ id: 'salary-usd', name: 'Salario en dólares', amount: 3000, currency: 'USD', frequency: 'monthly', category: 'Salario', date: '2026-11-01', exchangeRate: capturedRates }],
  expenses: [
    { id: 'rent-nio', name: 'Renta en córdobas', amount: 8000, currency: 'NIO', kind: 'fixed', category: 'Vivienda', frequency: 'monthly', date: '2026-11-01', exchangeRate: capturedRates },
    { id: 'purchase-eur', name: 'Compra en euros', amount: 50, currency: 'EUR', kind: 'variable', category: 'Otros', frequency: 'once', date: '2026-11-04', exchangeRate: capturedRates },
  ],
  goals: [], savingsAmount: 300, savingsCurrency: 'USD', savingsExchangeRate: capturedRates, legacyCurrency: 'USD',
};

async function mockBac(page: Page, status = 200) {
  await page.route(BAC_URL, route => route.fulfill({
    status,
    contentType: status === 200 ? 'application/xml' : 'text/plain',
    headers: { 'access-control-allow-origin': '*' },
    body: status === 200 ? `<?xml version="1.0"?><exchangeRates>
      <country><name>Costa Rica</name><saleRateUSD>999</saleRateUSD><saleRateEUR>999</saleRateEUR></country>
      <country><name>Nicaragua</name><saleRateUSD>40</saleRateUSD><saleRateEUR>50</saleRateEUR><buyRateUSD>39</buyRateUSD><buyRateEUR>49</buyRateEUR></country>
    </exchangeRates>` : 'Denied by test fixture',
  }));
}

async function openApp(page: Page, data: unknown, currency: 'USD' | 'NIO' | 'EUR' = 'USD', status = 200) {
  await page.clock.setFixedTime(new Date('2026-11-07T18:00:00.000Z'));
  await mockBac(page, status);
  await page.addInitScript(({ finance, summaryCurrency, financeKey, prefKey }) => {
    // Seed this isolated test context once; reload must exercise real persistence.
    if (!localStorage.getItem(financeKey)) {
      localStorage.setItem(financeKey, JSON.stringify(finance));
      localStorage.setItem(prefKey, JSON.stringify({ currency: summaryCurrency, rateType: 'sell', demo: false }));
    }
  }, { finance: data, summaryCurrency: currency, financeKey: FINANCE_KEY, prefKey: PREF_KEY });
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: 'Moneda del resumen', exact: true })).toHaveValue(currency);
  await page.getByLabel('Mes del resumen').fill('2026-11');
}

function stat(page: Page, label: string) {
  return page.locator('.stat-card').filter({ hasText: label }).locator('.stat-value');
}

async function financeData(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), FINANCE_KEY);
}

async function cachedRates(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), RATE_KEY);
}

async function waitForFixtureRates(page: Page) {
  await expect.poll(() => cachedRates(page)).toMatchObject({ usd: 40, eur: 50, rateType: 'sell', provider: 'BAC', dateKind: 'observed' });
}

async function saveManualRates(page: Page, usd = 40, eur = 50) {
  await page.locator('.workspace-selector').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Ingresar tasas manualmente', exact: true }).click();
  await dialog.getByLabel('Córdobas por 1 USD').fill(String(usd));
  await dialog.getByLabel('Córdobas por 1 EUR').fill(String(eur));
  await dialog.getByLabel('Fecha efectiva', { exact: true }).fill('2026-11-07');
  await dialog.getByRole('button', { name: 'Aplicar referencia manual', exact: true }).click();
  await expect(dialog.getByText('Referencia manual aplicada.', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Fuente: referencia manual', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cerrar ventana', exact: true }).click();
}

async function createMovement(page: Page, options: { kind: 'income' | 'expense'; currency: 'USD' | 'NIO' | 'EUR'; amount: number; name: string; biweekly?: boolean }) {
  await page.getByRole('button', { name: 'Nuevo movimiento', exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (options.kind === 'income') await dialog.getByRole('button', { name: 'Ingreso', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Moneda del movimiento', exact: true }).selectOption(options.currency);
  await dialog.getByLabel(`Monto (${options.currency})`, { exact: true }).fill(String(options.amount));
  await dialog.getByLabel('Concepto', { exact: true }).fill(options.name);
  if (options.biweekly) await dialog.getByRole('combobox', { name: 'Periodicidad', exact: true }).selectOption('biweekly');
  await dialog.getByLabel(options.kind === 'income' ? 'Fecha de inicio' : 'Fecha', { exact: true }).fill('2026-11-01');
  return dialog;
}

async function downloadBytes(page: Page, choice: string, extension: string) {
  await page.getByRole('button', { name: 'Exportar', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: new RegExp(choice) }).click();
  const download: Download = await pending;
  expect(download.suggestedFilename()).toContain(extension);
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  expect(bytes.byteLength).toBeGreaterThan(100);
  return bytes;
}

test('el resumen convierte USD, NIO y EUR sin alterar los importes originales ni sus tasas guardadas', async ({ page }) => {
  await openApp(page, mixedData);
  await waitForFixtureRates(page);
  await expect(stat(page, 'Ingresos del mes')).toHaveText('$3,000.00');
  await expect(stat(page, 'Gastos fijos')).toHaveText('$200.00');
  await expect(stat(page, 'Ahorro reservado')).toHaveText('$300.00');
  await expect(stat(page, 'Disponible para ti')).toHaveText('$2,437.50');

  const before = await financeData(page);
  await page.getByRole('combobox', { name: 'Moneda del resumen', exact: true }).selectOption('NIO');
  await expect(stat(page, 'Disponible para ti')).toHaveText(/97,500\.00/);
  await page.getByRole('combobox', { name: 'Moneda del resumen', exact: true }).selectOption('EUR');
  await expect(stat(page, 'Disponible para ti')).toHaveText('€1,950.00');
  expect(await financeData(page)).toEqual(before);
  await page.reload();
  await page.getByLabel('Mes del resumen').fill('2026-11');
  await expect(page.getByRole('combobox', { name: 'Moneda del resumen', exact: true })).toHaveValue('EUR');
  await expect(stat(page, 'Disponible para ti')).toHaveText('€1,950.00');
  expect(await financeData(page)).toEqual(before);

  // A changed global reference affects new/pending entries, not captured history.
  await saveManualRates(page, 80, 100);
  await page.getByRole('combobox', { name: 'Moneda del resumen', exact: true }).selectOption('NIO');
  await expect(stat(page, 'Disponible para ti')).toHaveText(/97,500\.00/);
  await page.getByRole('combobox', { name: 'Moneda del resumen', exact: true }).selectOption('USD');
  await expect(stat(page, 'Disponible para ti')).toHaveText('$2,437.50');
  expect(await financeData(page)).toEqual(before);

  // Editing the concept alone also preserves the original currency and snapshot.
  await page.getByRole('button', { name: 'Movimientos', exact: true }).click();
  await page.getByRole('button', { name: 'Editar Renta en córdobas', exact: true }).click();
  const edit = page.getByRole('dialog');
  await expect(edit.getByRole('combobox', { name: 'Moneda del movimiento', exact: true })).toHaveValue('NIO');
  await edit.getByLabel('Concepto', { exact: true }).fill('Renta en córdobas revisada');
  await edit.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  expect((await financeData(page)).expenses.find((entry: { id: string }) => entry.id === 'rent-nio')).toMatchObject({ amount: 8000, currency: 'NIO', exchangeRate: capturedRates });
});

test('guarda cada movimiento en su moneda y cuenta dos pagos por ingreso quincenal', async ({ page }) => {
  await openApp(page, emptyData);
  await waitForFixtureRates(page);
  let dialog = await createMovement(page, { kind: 'income', currency: 'NIO', amount: 4000, name: 'Quincena en córdobas', biweekly: true });
  await expect(dialog).toContainText('Equivalente por pago');
  await expect(dialog).toContainText('$100.00');
  await dialog.getByRole('button', { name: 'Añadir ingreso', exact: true }).click();
  await expect(stat(page, 'Ingresos del mes')).toHaveText('$200.00');
  dialog = await createMovement(page, { kind: 'expense', currency: 'EUR', amount: 50, name: 'Compra europea' });
  await expect(dialog).toContainText('$62.50');
  await dialog.getByRole('button', { name: 'Añadir gasto', exact: true }).click();
  await expect(stat(page, 'Disponible para ti')).toHaveText('$137.50');
  const saved = await financeData(page);
  expect(saved.incomes).toHaveLength(1);
  expect(saved.incomes[0]).toMatchObject({ name: 'Quincena en córdobas', amount: 4000, currency: 'NIO', frequency: 'biweekly', exchangeRate: { usd: 40, eur: 50, provider: 'BAC', rateType: 'sell', dateKind: 'observed', date: '2026-11-07' } });
  expect(saved.expenses[0]).toMatchObject({ name: 'Compra europea', amount: 50, currency: 'EUR', kind: 'variable', exchangeRate: { usd: 40, eur: 50, provider: 'BAC', rateType: 'sell' } });
  await page.getByRole('button', { name: 'Movimientos', exact: true }).click();
  const row = page.locator('.movement-table tbody tr').filter({ hasText: 'Quincena en córdobas' });
  await expect(row).toContainText('4,000.00');
  await expect(row).toContainText('200.00');
  await expect(row).toContainText('NIO');
  await page.getByRole('button', { name: 'Resumen general', exact: true }).click();
  await page.getByRole('combobox', { name: 'Moneda del resumen', exact: true }).selectOption('NIO');
  await expect(stat(page, 'Disponible para ti')).toHaveText(/5,500\.00/);
  await page.reload();
  await page.getByLabel('Mes del resumen').fill('2026-11');
  await expect(stat(page, 'Disponible para ti')).toHaveText(/5,500\.00/);
  expect(await financeData(page)).toEqual(saved);
});

test('BAC 403 deja conversiones pendientes y una referencia manual permite completarlas y recargar', async ({ page }) => {
  const pendingData = {
    ...emptyData,
    incomes: [{ id: 'salary', name: 'Ingreso en dólares', amount: 1000, currency: 'USD', category: 'Salario', frequency: 'monthly', date: '2026-11-01' }],
    expenses: [{ id: 'rent', name: 'Compromiso en córdobas', amount: 8000, currency: 'NIO', kind: 'fixed', category: 'Vivienda', frequency: 'monthly', date: '2026-11-01' }],
  };
  await openApp(page, pendingData, 'USD', 403);
  await expect(stat(page, 'Disponible para ti')).toHaveText('Sin tasa');
  await expect(stat(page, 'Ingresos del mes')).toHaveText('$1,000.00');
  await expect(stat(page, 'Gastos fijos')).toHaveText('Sin tasa');
  await expect(page.locator('.recharts-pie .recharts-sector')).toHaveCount(0);
  await page.locator('.workspace-selector').click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/BAC no permite consultar sus tasas.*403/)).toBeVisible();
  await expect(dialog.getByText('Sin tipo de cambio disponible', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cerrar ventana', exact: true }).click();
  dialog = await createMovement(page, { kind: 'expense', currency: 'EUR', amount: 50, name: 'Gasto pendiente en euros' });
  await expect(dialog).toContainText(/pendiente|Sin tasa/i);
  await dialog.getByRole('button', { name: 'Añadir gasto', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const pending = (await financeData(page)).expenses.find((entry: { name: string }) => entry.name === 'Gasto pendiente en euros');
  expect(pending).toMatchObject({ amount: 50, currency: 'EUR' });
  expect(pending.exchangeRate).toBeUndefined();
  await expect(stat(page, 'Disponible para ti')).toHaveText('Sin tasa');
  expect(await cachedRates(page)).toBeNull();

  await saveManualRates(page);
  await expect(stat(page, 'Gastos fijos')).toHaveText('$200.00');
  await expect(stat(page, 'Disponible para ti')).toHaveText('$737.50');
  const manual = await cachedRates(page);
  expect(manual).toMatchObject({ usd: 40, eur: 50, provider: 'manual', rateType: 'sell', date: '2026-11-07', dateKind: 'effective' });
  const saved = await financeData(page);
  await page.reload();
  await page.getByLabel('Mes del resumen').fill('2026-11');
  await expect(stat(page, 'Disponible para ti')).toHaveText('$737.50');
  expect(await financeData(page)).toEqual(saved);
  expect(await cachedRates(page)).toEqual(manual);
});

test('migra registros antiguos en EUR sin cambiar montos y convierte realmente al cambiar el resumen', async ({ page }) => {
  const legacyData = {
    incomes: [{ id: 'legacy-income', name: 'Salario antiguo', amount: 1000, frequency: 'monthly', category: 'Salario', date: '2026-11-01' }],
    expenses: [{ id: 'legacy-rent', name: 'Renta antigua', amount: 100, kind: 'fixed', category: 'Vivienda', frequency: 'monthly', date: '2026-11-01' }],
    goals: [{ id: 'legacy-goal', name: 'Meta antigua', target: 2000, saved: 200, monthly: 50 }],
    savingsAmount: 100,
  };
  await openApp(page, legacyData, 'EUR');
  await waitForFixtureRates(page);
  await expect(stat(page, 'Disponible para ti')).toHaveText('€800.00');
  const migrated = await financeData(page);
  expect(migrated.incomes[0]).toMatchObject({ ...legacyData.incomes[0], currency: 'EUR' });
  expect(migrated.expenses[0]).toMatchObject({ ...legacyData.expenses[0], currency: 'EUR' });
  expect(migrated.goals[0]).toMatchObject({ ...legacyData.goals[0], currency: 'EUR' });
  expect(migrated).toMatchObject({ legacyCurrency: 'EUR', savingsCurrency: 'EUR', savingsAmount: 100 });
  await page.getByRole('combobox', { name: 'Moneda del resumen', exact: true }).selectOption('USD');
  await expect(stat(page, 'Ingresos del mes')).toHaveText('$1,250.00');
  await expect(stat(page, 'Disponible para ti')).toHaveText('$1,000.00');
  await page.getByRole('combobox', { name: 'Moneda del resumen', exact: true }).selectOption('NIO');
  await expect(stat(page, 'Disponible para ti')).toHaveText(/40,000\.00/);
  expect(await financeData(page)).toEqual(migrated);
  await page.reload();
  await page.getByLabel('Mes del resumen').fill('2026-11');
  await expect(page.getByRole('combobox', { name: 'Moneda del resumen', exact: true })).toHaveValue('NIO');
  await expect(stat(page, 'Disponible para ti')).toHaveText(/40,000\.00/);
  expect(await financeData(page)).toEqual(migrated);
});

test('CSV y Excel conservan moneda original y equivalentes, y los informes PDF y Word son archivos válidos', async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page, mixedData, 'NIO');
  await waitForFixtureRates(page);
  await expect(stat(page, 'Disponible para ti')).toHaveText(/97,500\.00/);
  for (const [choice, extension] of [['Tabla de movimientos', '.csv'], ['Hoja de cálculo', '.xlsx']] as const) {
    const bytes = await downloadBytes(page, choice, extension);
    // Read bytes so SheetJS consumes the UTF-8 BOM used for Excel-compatible CSV.
    // Passing a decoded string leaves the BOM attached to the first header.
    const workbook = extension === '.csv'
      ? XLSX.read(bytes, { type: 'buffer', raw: true })
      : XLSX.read(bytes, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets[workbook.SheetNames[0]]);
    expect(rows).toHaveLength(3);
    for (const [concept, originalCurrency, originalAmount, equivalent] of [
      ['Salario en dólares', 'USD', 3000, 120000],
      ['Renta en córdobas', 'NIO', -8000, -8000],
      ['Compra en euros', 'EUR', -50, -2500],
    ] as const) {
      const row = rows.find(value => value.Concepto === concept);
      expect(row).toBeTruthy();
      expect(Number(row!['Importe por pago'])).toBe(originalAmount);
      expect(Number(row!['Total del mes'])).toBe(equivalent);
      const originalHeader = Object.keys(row!).find(key => /moneda.*original/i.test(key));
      const summaryHeader = Object.keys(row!).find(key => /moneda.*resumen/i.test(key));
      expect(originalHeader, 'Debe exportarse la moneda original').toBeTruthy();
      expect(summaryHeader, 'Debe identificarse la moneda de los equivalentes').toBeTruthy();
      expect(row![originalHeader!]).toBe(originalCurrency);
      expect(row![summaryHeader!]).toBe('NIO');
    }
  }
  const pdf = await downloadBytes(page, 'Informe financiero', '.pdf');
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.toString('latin1')).toContain('97,500.00');
  const word = await downloadBytes(page, 'Informe editable', '.docx');
  expect(word.subarray(0, 2).toString()).toBe('PK');
  // SheetJS exposes its ZIP reader through the CommonJS entry point only.
  const zipReader = createRequire(import.meta.url)('xlsx').CFB;
  const archive = zipReader.read(word, { type: 'buffer' });
  const document = zipReader.find(archive, '/word/document.xml');
  expect(document).toBeTruthy();
  const xml = Buffer.from(document.content).toString('utf8');
  expect(xml).toContain('KONTEN');
  expect(xml).toContain('97,500.00');
  expect(xml).toContain('Renta en córdobas');
  expect(xml).not.toContain('Sin tasa');
});
