import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';

const artifact = resolve('downloads/KONTEN.html');

test('el HTML portátil se puede abrir directamente como archivo', async ({ page, context }) => {
  test.skip(!existsSync(artifact), 'Genera primero el HTML con npm run build:portable.');
  await context.setOffline(true);
  try {
    await page.goto(pathToFileURL(artifact).href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    test.skip(message.includes('ERR_BLOCKED_BY_ADMINISTRATOR'), 'La política del Chromium administrado bloquea file://; la apertura directa requiere otro navegador.');
    throw error;
  }
  await expect(page.getByRole('heading', { name: 'Cada peso, con propósito.' })).toBeVisible();
});

test('el HTML autónomo no necesita recursos de red y genera cinco exportaciones', async ({ page, context }) => {
  test.skip(!existsSync(artifact), 'Genera primero el HTML con npm run build:portable.');
  await context.setOffline(true);
  const scriptErrors: string[] = [];
  const remoteRequests: string[] = [];
  const failedResources: string[] = [];
  page.on('pageerror', error => scriptErrors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && request.url() !== 'https://balance-portable.test/') remoteRequests.push(request.url());
  });
  page.on('requestfailed', request => failedResources.push(request.url()));
  await page.addInitScript(() => {
    if (!localStorage.getItem('balance-finance-v1')) {
      localStorage.setItem('balance-finance-v1', JSON.stringify({ incomes: [], expenses: [], goals: [], savingsAmount: 0 }));
    }
  });
  // Serve the artifact entirely from memory. Offline mode stays enabled and all
  // other HTTP requests are observed, so split chunks or remote fonts fail here.
  // This validates the bundle even where managed browser policy blocks file://.
  await page.route('https://balance-portable.test/', async route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: await readFile(artifact) }));
  await page.goto('https://balance-portable.test/');
  await expect(page.getByRole('heading', { name: 'Cada peso, con propósito.' })).toBeVisible();
  await page.getByLabel('Mes del resumen').fill('2026-11');
  await page.getByRole('button', { name: 'Nuevo movimiento', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Ingreso', exact: true }).click();
  await dialog.getByLabel('Concepto', { exact: true }).fill('Salario sin conexión');
  await dialog.getByLabel('Monto (USD)').fill('1500');
  await dialog.getByLabel('Fecha de inicio', { exact: true }).fill('2026-11-01');
  await dialog.getByRole('button', { name: 'Añadir ingreso', exact: true }).click();
  const incomeValue = page.locator('.stat-card').filter({ hasText: 'Ingresos del mes' }).locator('.stat-value');
  await expect(incomeValue).toHaveText('$1,500.00');
  await page.reload();
  await page.getByLabel('Mes del resumen').fill('2026-11');
  await expect(incomeValue).toHaveText('$1,500.00');

  const formats = [
    { label: 'Tabla de movimientos', extension: '.csv' },
    { label: 'Hoja de cálculo', extension: '.xlsx' },
    { label: 'Informe financiero', extension: '.pdf' },
    { label: 'Informe editable', extension: '.docx' },
    { label: 'Captura de esta vista', extension: '.png' },
  ];
  for (const format of formats) {
    await page.getByRole('button', { name: 'Exportar', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: new RegExp(format.label) }).click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toContain(format.extension);
    const file = await download.path();
    expect(file).toBeTruthy();
    const bytes = await readFile(file!);
    expect(bytes.byteLength).toBeGreaterThan(100);
    if (format.extension === '.csv') {
      expect(bytes.toString('utf8')).toContain('Salario sin conexión');
    } else if (format.extension === '.xlsx') {
      const workbook = XLSX.read(bytes);
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      expect(rows).toContainEqual(expect.objectContaining({ Concepto: 'Salario sin conexión', 'Total del mes': 1500 }));
    } else if (format.extension === '.pdf') {
      expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    } else if (format.extension === '.docx') {
      expect(bytes.subarray(0, 2).toString()).toBe('PK');
    } else {
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    }
  }
  await page.screenshot({ path: '/tmp/balance-portable.png', fullPage: true });
  expect(scriptErrors).toEqual([]);
  expect(remoteRequests).toEqual([]);
  expect(failedResources).toEqual([]);
});
