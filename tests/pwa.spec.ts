import { test, expect, chromium, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

async function openPreparedApp(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem('balance-finance-v1')) localStorage.setItem('balance-finance-v1', JSON.stringify({
      incomes: [{ id: 'salary', name: 'Salario existente', amount: 3000, frequency: 'monthly', category: 'Salario', date: '2026-01-01' }],
      expenses: [{ id: 'rent', name: 'Alquiler existente', amount: 800, kind: 'fixed', frequency: 'monthly', category: 'Vivienda', date: '2026-01-01' }],
      goals: [], savingsAmount: 300,
    }));
  });
  await page.goto('./');
  await page.getByLabel('Mes del resumen').fill('2026-11');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  await expect(page.locator('.stat-card.accent .stat-value')).toHaveText('$1,900.00');
}

test('manifest, icono y service worker cumplen los requisitos de instalación bajo /account/', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'konten-pwa-install-'));
  const context = await chromium.launchPersistentContext(profile, { baseURL: 'http://127.0.0.1:4180/account/', locale: 'es-NI', timezoneId: 'America/Managua', ...(existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}) });
  const page = await context.newPage();
  try {
  await openPreparedApp(page);
  const manifestUrl = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestUrl).toBeTruthy();
  const response = await page.request.get(new URL(manifestUrl!, page.url()).href);
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.name).toBe('KONTEN');
  expect(manifest.short_name).toBe('KONTEN');
  expect(manifest.display).toBe('standalone');
  expect(new URL(manifest.start_url, response.url()).pathname).toBe('/account/');
  expect(new URL(manifest.scope, response.url()).pathname).toBe('/account/');
  const registration = await page.evaluate(async () => ({ scope: (await navigator.serviceWorker.ready).scope, script: navigator.serviceWorker.controller?.scriptURL }));
  expect(new URL(registration.scope).pathname).toBe('/account/');
  expect(new URL(registration.script!).pathname).toBe('/account/sw.js');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const appManifest = await cdp.send('Page.getAppManifest');
  expect(appManifest.errors).toEqual([]);
  const result = await cdp.send('Page.getInstallabilityErrors');
  expect(result.installabilityErrors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('funciona sin conexión: conserva registros, permite un gasto y exporta todos los formatos', async ({ page, context }) => {
  await openPreparedApp(page);
  await context.setOffline(true);
  await page.goto('./?v=offline-check');
  await page.getByLabel('Mes del resumen').fill('2026-11');
  await expect(page).toHaveTitle('KONTEN — Cada peso, con propósito');
  await expect(page.locator('.stat-card.accent .stat-value')).toHaveText('$1,900.00');
  await page.getByRole('button', { name: 'Nuevo movimiento', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Concepto', { exact: true }).fill('Compra sin conexión');
  await dialog.getByLabel('Monto (USD)').fill('50');
  await dialog.getByLabel('Fecha', { exact: true }).fill('2026-11-06');
  await dialog.getByRole('button', { name: 'Añadir gasto', exact: true }).click();
  await expect(page.locator('.stat-card.accent .stat-value')).toHaveText('$1,850.00');
  await page.reload();
  await page.getByLabel('Mes del resumen').fill('2026-11');
  await expect(page.locator('.stat-card.accent .stat-value')).toHaveText('$1,850.00');
  const formats = [
    ['Tabla de movimientos', '.csv'], ['Hoja de cálculo', '.xlsx'],
    ['Informe financiero', '.pdf'], ['Informe editable', '.docx'], ['Captura de esta vista', '.png'],
  ];
  for (const [label, extension] of formats) {
    await page.getByRole('button', { name: 'Exportar', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: new RegExp(label) }).click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toContain(extension);
    const bytes = await readFile((await download.path())!);
    expect(bytes.length).toBeGreaterThan(100);
    if (extension === '.csv') expect(bytes.toString('utf8')).toContain('Compra sin conexión');
    if (extension === '.pdf') expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    if (extension === '.xlsx' || extension === '.docx') expect(bytes.subarray(0, 2).toString()).toBe('PK');
    if (extension === '.png') expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  }
});

test('el botón usa la solicitud del navegador y cancelar no marca la app como instalada', async ({ page }) => {
  await openPreparedApp(page);
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, { prompt: async () => { sessionStorage.setItem('install-prompt-called', 'yes'); }, userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }) });
    window.dispatchEvent(event);
  });
  await page.getByRole('button', { name: /^Mis finanzas/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Instalar KONTEN', exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('install-prompt-called'))).toBe('yes');
  await expect(dialog.getByText('Cancelaste la solicitud.', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'KONTEN instalada', exact: true })).not.toBeVisible();
});
