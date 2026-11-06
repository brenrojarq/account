import { test, expect, type Page, type Download } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import * as XLSX from 'xlsx';

const seededData = {
  incomes: [{ id: 'salary', name: 'Salario principal', amount: 3000, frequency: 'monthly', category: 'Salario', date: '2026-11-01' }],
  expenses: [
    { id: 'rent', name: 'Renta del apartamento', amount: 800, kind: 'fixed', category: 'Vivienda', frequency: 'monthly', date: '2026-11-01' },
    { id: 'dinner', name: 'Cena con amigos', amount: 125, kind: 'variable', category: 'Alimentación', frequency: 'once', date: '2026-11-04' },
  ],
  goals: [{ id: 'trip', name: 'Mi viaje', target: 3000, saved: 500, monthly: 100 }],
  savingsAmount: 300,
};

async function openApp(page: Page, data?: unknown) {
  if (data) {
    await page.addInitScript((initial) => {
      if (!localStorage.getItem('balance-finance-v1')) localStorage.setItem('balance-finance-v1', JSON.stringify(initial));
    }, data);
  }
  await page.goto('/');
  await page.getByLabel('Mes del resumen').fill('2026-11');
}

function stat(page: Page, label: string) {
  return page.locator('.stat-card').filter({ hasText: label }).locator('.stat-value');
}

async function addMovement(page: Page, kind: 'income' | 'fixed' | 'variable', name: string, amount: number) {
  await page.getByRole('button', { name: 'Nuevo movimiento', exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (kind === 'income') await dialog.getByRole('button', { name: 'Ingreso', exact: true }).click();
  else await dialog.getByRole('radio', { name: kind === 'fixed' ? 'Fijo Un compromiso recurrente' : 'Variable Un gasto de este momento' }).check();
  await dialog.getByLabel('Monto (USD)').fill(String(amount));
  await dialog.getByLabel('Concepto', { exact: true }).fill(name);
  if (kind !== 'income') await dialog.getByLabel('Clasificación').selectOption(kind === 'fixed' ? 'Vivienda' : 'Alimentación');
  await dialog.getByLabel(kind === 'variable' ? 'Fecha' : 'Fecha de inicio', { exact: true }).fill('2026-11-01');
  if (kind === 'income') await expect(dialog.getByLabel('Periodicidad')).toHaveValue('monthly');
  await dialog.getByRole('button', { name: kind === 'income' ? 'Añadir ingreso' : 'Añadir gasto', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function downloadBytes(download: Download) {
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).toBeTruthy();
  return readFile(path!);
}

test('salario y compromisos se repiten; variables y reserva determinan el disponible', async ({ page }) => {
  await openApp(page, { incomes: [], expenses: [], goals: [], savingsAmount: 0 });
  await expect(stat(page, 'Disponible para ti')).toHaveText('$0.00');
  await addMovement(page, 'income', 'Mi salario', 3000);
  await addMovement(page, 'fixed', 'Mi renta', 800);
  await addMovement(page, 'variable', 'Cena del viernes', 125);
  await expect(stat(page, 'Ingresos del mes')).toHaveText('$3,000.00');
  await expect(stat(page, 'Gastos fijos')).toHaveText('$800.00');
  await expect(stat(page, 'Disponible para ti')).toHaveText('$2,075.00');

  await page.getByRole('button', { name: 'Mi presupuesto', exact: true }).click();
  await page.getByLabel('Ahorro mensual (USD)').fill('300');
  await page.getByRole('button', { name: 'Actualizar ahorro' }).click();
  await expect(stat(page, 'Ahorro reservado')).toHaveText('$300.00');
  await expect(stat(page, 'Disponible para ti')).toHaveText('$1,775.00');
  await page.reload();
  await page.getByLabel('Mes del resumen').fill('2026-11');
  await expect(stat(page, 'Disponible para ti')).toHaveText('$1,775.00');
  await page.getByRole('button', { name: 'Mes siguiente' }).click();
  await expect(stat(page, 'Ingresos del mes')).toHaveText('$3,000.00');
  await expect(stat(page, 'Gastos fijos')).toHaveText('$800.00');
  await expect(stat(page, 'Disponible para ti')).toHaveText('$1,900.00');
});

test('quincenas y devoluciones puntuales se suman al periodo correcto', async ({ page }) => {
  await openApp(page, { incomes: [], expenses: [], goals: [], savingsAmount: 0 });
  await page.getByRole('button', { name: 'Nuevo movimiento' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Ingreso', exact: true }).click();
  await dialog.getByLabel('Concepto', { exact: true }).fill('Pago quincenal');
  await dialog.getByLabel('Monto (USD)').fill('750');
  await dialog.getByLabel('Periodicidad').selectOption('biweekly');
  await dialog.getByLabel('Fecha de inicio', { exact: true }).fill('2026-11-01');
  await dialog.getByRole('button', { name: 'Añadir ingreso', exact: true }).click();
  await page.getByRole('button', { name: 'Nuevo movimiento' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Ingreso', exact: true }).click();
  await dialog.getByLabel('Fuente de ingreso').selectOption('Devolución de préstamo');
  await expect(dialog.getByLabel('Periodicidad')).toHaveValue('once');
  await dialog.getByLabel('Concepto', { exact: true }).fill('Me devolvieron el préstamo');
  await dialog.getByLabel('Monto (USD)').fill('100');
  await dialog.getByLabel('Fecha', { exact: true }).fill('2026-11-02');
  await dialog.getByRole('button', { name: 'Añadir ingreso', exact: true }).click();
  await expect(stat(page, 'Ingresos del mes')).toHaveText('$1,600.00');
  await page.getByRole('button', { name: 'Mes siguiente' }).click();
  await expect(stat(page, 'Ingresos del mes')).toHaveText('$1,500.00');
});

test('gráficas y tarjetas personalizadas conservan las preferencias', async ({ page }) => {
  await openApp(page, seededData);
  await page.getByRole('button', { name: 'Gráfica de barras', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Gráfica de barras', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.recharts-bar')).toBeVisible();
  await page.getByRole('button', { name: 'Gráfica de puntos', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Gráfica de puntos', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.recharts-scatter')).toBeVisible();
  await page.getByRole('button', { name: 'Gráfica de pastel', exact: true }).click();
  await page.getByLabel('Tipo de gastos de la gráfica').selectOption('fixed');
  await expect(page.locator('.donut-label strong')).toHaveText('$800');

  await page.getByRole('button', { name: 'Personalizar vista' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'Ingresos del mes', exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: 'Metas de ahorro', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Barras', exact: true }).click();
  await dialog.getByRole('button', { name: 'Guardar mi vista' }).click();
  await expect(page.locator('.stat-card')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Un paso más cerca' })).not.toBeVisible();
  await page.reload();
  await page.getByLabel('Mes del resumen').fill('2026-11');
  await expect(page.locator('.stat-card')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Gráfica de barras', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('los filtros y la búsqueda encuentran movimientos y permiten editarlos', async ({ page }) => {
  await openApp(page, seededData);
  await page.getByRole('button', { name: 'Movimientos', exact: true }).click();
  const rows = page.locator('.movement-table tbody tr');
  await expect(rows).toHaveCount(3);
  await page.getByRole('button', { name: 'Gastos fijos', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Renta del apartamento');
  await page.getByRole('button', { name: 'Todos', exact: true }).click();
  await page.getByPlaceholder('Buscar movimiento…').fill('amigos');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Cena con amigos');
  await page.getByRole('button', { name: 'Editar Cena con amigos' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Monto (USD)').fill('150');
  await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(rows).toContainText('150.00');
  await page.getByRole('button', { name: 'Resumen general', exact: true }).click();
  await expect(stat(page, 'Disponible para ti')).toHaveText('$1,750.00');
});

test('añadir un compromiso desde presupuesto lo crea fijo y se puede eliminar su recurrencia', async ({ page }) => {
  await openApp(page, seededData);
  await page.getByRole('button', { name: 'Mi presupuesto', exact: true }).click();
  await page.getByRole('button', { name: 'Añadir gasto fijo', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('radio', { name: 'Fijo Un compromiso recurrente' })).toBeChecked();
  await expect(dialog.getByLabel('Periodicidad')).toHaveValue('monthly');
  await dialog.getByLabel('Clasificación').selectOption('Transporte');
  await dialog.getByLabel('Concepto', { exact: true }).fill('Seguro del carro');
  await dialog.getByLabel('Monto (USD)').fill('120');
  await dialog.getByLabel('Fecha de inicio').fill('2026-11-01');
  await dialog.getByRole('button', { name: 'Añadir gasto', exact: true }).click();
  await expect(stat(page, 'Gastos fijos')).toHaveText('$920.00');
  await expect(stat(page, 'Disponible para ti')).toHaveText('$1,655.00');
  await page.getByRole('button', { name: 'Movimientos', exact: true }).click();
  page.once('dialog', async confirmation => {
    expect(confirmation.message()).toContain('recurrencia');
    await confirmation.accept();
  });
  await page.getByRole('button', { name: 'Eliminar Seguro del carro', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Editar Seguro del carro', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Resumen general', exact: true }).click();
  await expect(stat(page, 'Gastos fijos')).toHaveText('$800.00');
});

test('las metas registran progreso y sus aportes no duplican el ahorro reservado', async ({ page }) => {
  await openApp(page, seededData);
  await page.getByRole('button', { name: 'Metas de ahorro', exact: true }).click();
  await page.getByRole('button', { name: 'Nueva meta', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nombre de la meta').fill('Mi maestría');
  await dialog.getByLabel('Quiero alcanzar (USD)').fill('4000');
  await dialog.getByLabel('Ya tengo ahorrado (USD)').fill('1000');
  await dialog.getByLabel('Aporte mensual sugerido (USD)').fill('150');
  await dialog.getByRole('button', { name: 'Guardar mi meta' }).click();
  const goal = page.locator('.goal-full').filter({ hasText: 'Mi maestría' });
  await expect(goal).toContainText('25% de tu meta');
  await page.getByRole('button', { name: 'Editar meta Mi maestría', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Ya tengo ahorrado (USD)').fill('2000');
  await dialog.getByRole('button', { name: 'Guardar mi meta' }).click();
  await expect(goal).toContainText('50% de tu meta');
  await page.getByRole('button', { name: 'Resumen general', exact: true }).click();
  await expect(stat(page, 'Ahorro reservado')).toHaveText('$300.00');
  await expect(stat(page, 'Disponible para ti')).toHaveText('$1,775.00');
  await page.getByRole('button', { name: 'Metas de ahorro', exact: true }).click();
  await page.getByRole('button', { name: 'Editar meta Mi maestría', exact: true }).click();
  page.once('dialog', confirmation => confirmation.accept());
  await page.getByRole('button', { name: 'Eliminar meta', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mi maestría', exact: true })).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Mi viaje', exact: true })).toBeVisible();
});

test('exporta archivos reales CSV, Excel, PDF, Word y PNG', async ({ page }) => {
  await openApp(page, seededData);
  const choices = [
    { name: 'Tabla de movimientos', extension: '.csv' },
    { name: 'Hoja de cálculo', extension: '.xlsx' },
    { name: 'Informe financiero', extension: '.pdf' },
    { name: 'Informe editable', extension: '.docx' },
    { name: 'Captura de esta vista', extension: '.png' },
  ];
  for (const choice of choices) {
    await page.getByRole('button', { name: 'Exportar', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: new RegExp(choice.name) }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toContain(choice.extension);
    const bytes = await downloadBytes(download);
    expect(bytes.byteLength).toBeGreaterThan(100);
    if (choice.extension === '.csv') {
      const text = bytes.toString('utf8');
      expect(text).toContain('Salario principal');
      expect(text).toContain('Cena con amigos');
      expect(text).toContain('-125');
    } else if (choice.extension === '.xlsx') {
      const workbook = XLSX.read(bytes);
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      expect(rows).toHaveLength(3);
      expect(rows).toContainEqual(expect.objectContaining({ Concepto: 'Renta del apartamento', 'Total del mes': -800 }));
    } else if (choice.extension === '.pdf') expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    else if (choice.extension === '.docx') expect(bytes.subarray(0, 2).toString()).toBe('PK');
    else expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  }
});

test('el menú funciona en móvil y el dashboard de ejemplo se muestra completo', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.recharts-pie .recharts-sector').first()).toBeVisible();
  await page.screenshot({ path: '/tmp/balance-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -228, 0)');
  await expect(page.locator('.recharts-pie .recharts-sector').first()).toBeVisible();
  await page.screenshot({ path: '/tmp/balance-mobile-overview.png', fullPage: true });
  await page.getByRole('button', { name: 'Abrir menú' }).click();
  await page.getByRole('button', { name: 'Movimientos', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -228, 0)');
  await expect(page.getByRole('heading', { name: 'Los detalles hacen la diferencia.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/balance-mobile.png', fullPage: true });
});
