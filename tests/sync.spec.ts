import { test, expect, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';

// This is an application/transport integration test. Mock isolation does not
// establish database RLS; the separate SQL suite tests PostgreSQL authorization.
const API = 'https://konten-sync-test.supabase.co';
const BAC = 'https://www.sucursalelectronica.com/exchangerate/showXmlExchangeRate.do';
const FINANCE_KEY = 'balance-finance-v1';
const PREF_KEY = 'balance-preferences-v1';
const ALICE = 'alice-sync@example.test';
const BOB = 'bob-sync@example.test';
const ALICE_ID = '11111111-1111-4111-8111-111111111111';
const BOB_ID = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'synthetic-private-password';
const MANUAL_RATE = {
  usd: 40, eur: 50, rateType: 'sell', provider: 'manual',
  date: '2026-11-10', fetchedAt: '2026-11-10T18:00:00.000Z', dateKind: 'effective',
};
const sourceData = {
  legacyCurrency: 'USD', savingsCurrency: 'USD', savingsAmount: 300, savingsExchangeRate: MANUAL_RATE,
  incomes: [{ id: 'salary', name: 'Salario original USD', amount: 3000, currency: 'USD', category: 'Salario', frequency: 'monthly', date: '2026-11-01', exchangeRate: MANUAL_RATE }],
  expenses: [
    { id: 'rent', name: 'Alquiler original NIO', amount: 8000, currency: 'NIO', category: 'Vivienda', kind: 'fixed', frequency: 'monthly', date: '2026-11-01', exchangeRate: MANUAL_RATE },
    { id: 'euros', name: 'Compra original EUR', amount: 50, currency: 'EUR', category: 'Otros', kind: 'variable', frequency: 'once', date: '2026-11-04', exchangeRate: MANUAL_RATE },
  ],
  goals: [{ id: 'trip', name: 'Meta original EUR', target: 1000, saved: 200.1234, monthly: 20, currency: 'EUR', color: '#087f46', exchangeRate: MANUAL_RATE }],
};
const emptyData = { incomes: [], expenses: [], goals: [], savingsAmount: 0, legacyCurrency: 'USD', savingsCurrency: 'USD' };
const preferences = { currency: 'USD', rateType: 'sell', chart: 'pie', cards: ['income', 'fixed', 'savings', 'available'], showTransactions: true, showGoals: true, demo: false };
type Entity = 'income' | 'expense' | 'goal' | 'budget' | 'preferences';
type Row = { entity_type: Entity; entity_id: string; payload: unknown; deleted: boolean; revision: number; updated_at: string | null };
type Change = Omit<Row, 'revision' | 'updated_at'> & { expected_revision: number };
type Result = { applied: boolean; rows: Row[]; conflicts: Row[] };
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const rowKey = (row: Pick<Row, 'entity_type' | 'entity_id'>) => `${row.entity_type}:${row.entity_id}`;

class MockPrivateCloud {
  readonly records = new Map<string, Map<string, Row>>();
  readonly receipts = new Map<string, { request: string; result: Result }>();
  readonly requests: { uid: string; operation: string; changes: Change[] }[] = [];
  readonly unavailable = new Set<BrowserContext>();
  loseNextAcknowledgementFor: string | null = null;

  private user(email: string) {
    const id = email === BOB ? BOB_ID : ALICE_ID;
    return { id, email, aud: 'authenticated', role: 'authenticated', created_at: '2026-11-01T12:00:00.000Z', confirmed_at: '2026-11-01T12:00:00.000Z', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {} };
  }

  private token(email: string) {
    const user = this.user(email);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, email, aud: 'authenticated', role: 'authenticated', iat: 1794326400, exp: 4102444800, iss: `${API}/auth/v1` })}.synthetic-signature`;
  }

  private session(email: string) {
    return { access_token: this.token(email), token_type: 'bearer', refresh_token: `synthetic-${this.user(email).id}`, expires_in: 86400, expires_at: 4102444800, user: this.user(email) };
  }

  account(uid = ALICE_ID) {
    if (!this.records.has(uid)) this.records.set(uid, new Map());
    return this.records.get(uid)!;
  }

  liveRows(uid = ALICE_ID) { return [...this.account(uid).values()].filter(row => !row.deleted); }

  async attach(context: BrowserContext) {
    await context.route(BAC, route => route.abort('blockedbyclient'));
    await context.route(`${API}/**`, async route => {
      if (this.unavailable.has(context)) { await route.abort('internetdisconnected'); return; }
      const request = route.request();
      const url = new URL(request.url());
      const json = async (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value), headers: { 'access-control-allow-origin': '*' } });
      if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }); return; }
      const bearer = request.headers().authorization?.replace(/^Bearer /i, '') ?? '';
      let uid = '';
      try { uid = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sub; } catch { /* Missing credentials are rejected below. */ }
      if (url.pathname === '/auth/v1/token') {
        const body = request.postDataJSON() ?? {};
        const email = typeof body.email === 'string' ? body.email : String(body.refresh_token).includes(BOB_ID) ? BOB : ALICE;
        if (![ALICE, BOB].includes(email) || body.password && body.password !== PASSWORD) { await json({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400); return; }
        await json(this.session(email)); return;
      }
      if (url.pathname === '/auth/v1/user') { await json(this.user(uid === BOB_ID ? BOB : ALICE)); return; }
      if (url.pathname === '/auth/v1/logout') { await json({}); return; }
      if (![ALICE_ID, BOB_ID].includes(uid)) { await json({ message: 'JWT required' }, 401); return; }
      if (url.pathname === '/rest/v1/konten_records') {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 500);
        const sorted = [...this.account(uid).values()].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
        await json(sorted.slice(offset, offset + limit)); return;
      }
      if (url.pathname === '/rest/v1/rpc/konten_apply_changes') {
        const body = request.postDataJSON() as { p_operation_id: string; p_changes: Change[] };
        const receiptKey = `${uid}:${body.p_operation_id}`;
        const requestJson = JSON.stringify(body.p_changes);
        this.requests.push({ uid, operation: body.p_operation_id, changes: copy(body.p_changes) });
        const receipt = this.receipts.get(receiptKey);
        if (receipt) { await json(receipt.request === requestJson ? receipt.result : { message: 'operation_id reused' }, receipt.request === requestJson ? 200 : 409); return; }
        const account = this.account(uid);
        const conflicts = body.p_changes.filter(change => (account.get(rowKey(change))?.revision ?? 0) !== change.expected_revision)
          .map(change => account.get(rowKey(change)) ?? { entity_type: change.entity_type, entity_id: change.entity_id, revision: 0, deleted: true, payload: null, updated_at: null });
        if (conflicts.length) { await json({ applied: false, rows: [], conflicts }); return; }
        const rows = body.p_changes.map(change => ({ entity_type: change.entity_type, entity_id: change.entity_id, payload: copy(change.payload), deleted: change.deleted, revision: change.expected_revision + 1, updated_at: new Date().toISOString() }));
        for (const row of rows) account.set(rowKey(row), row);
        const result = { applied: true, rows, conflicts: [] };
        this.receipts.set(receiptKey, { request: requestJson, result: copy(result) });
        if (this.loseNextAcknowledgementFor === uid) { this.loseNextAcknowledgementFor = null; await route.abort('failed'); return; }
        await json(result); return;
      }
      await json({ message: `Unexpected mock endpoint ${url.pathname}` }, 404);
    });
  }
}

interface Device { context: BrowserContext; page: Page }
async function device(browser: Browser, cloud: MockPrivateCloud, data: unknown = emptyData, mobile = false): Promise<Device> {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 }, isMobile: mobile, hasTouch: mobile, locale: 'es-NI', timezoneId: 'America/Managua' });
  await cloud.attach(context);
  await context.addInitScript(({ data, preferences, rate, financeKey, prefKey }) => {
    if (localStorage.getItem(financeKey)) return;
    localStorage.setItem(financeKey, JSON.stringify(data));
    localStorage.setItem(prefKey, JSON.stringify(preferences));
    localStorage.setItem('konten:exchange-rates:v1:sell', JSON.stringify(rate));
  }, { data, preferences, rate: MANUAL_RATE, financeKey: FINANCE_KEY, prefKey: PREF_KEY });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Mes del resumen').fill('2026-11');
  return { context, page };
}

async function openAccount(page: Page) {
  const panel = page.getByRole('region', { name: 'Tu cuenta y sincronización', exact: true });
  if (!(await panel.isVisible())) {
    const menu = page.getByRole('button', { name: 'Abrir menú', exact: true });
    if (await menu.isVisible() && !(await page.locator('.sidebar').evaluate(element => element.classList.contains('open')))) await menu.click();
    await page.locator('.workspace-selector').click();
  }
  await expect(panel).toBeVisible();
  return panel;
}
async function closeAccount(page: Page) {
  const close = page.getByRole('button', { name: 'Cerrar ventana', exact: true });
  if (await close.isVisible()) await close.click();
  const backdrop = page.locator('.sidebar-backdrop');
  if (await backdrop.isVisible()) await backdrop.click({ position: { x: page.viewportSize()!.width - 4, y: 200 } });
}
async function login(page: Page, email = ALICE) {
  const panel = await openAccount(page);
  await panel.getByLabel('Correo electrónico', { exact: true }).fill(email);
  await panel.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await panel.getByRole('button', { name: 'Entrar a mi cuenta', exact: true }).click();
  await expect(panel).toContainText('Elegí con qué datos continuar');
  return panel;
}
async function activate(page: Page, importLocal: boolean, email = ALICE) {
  const panel = await login(page, email);
  await panel.getByRole('button', { name: importLocal ? 'Incorporar registros de este dispositivo' : 'Usar datos de mi cuenta', exact: true }).click();
  await expect(panel.locator('.cloud-status')).toContainText('Sincronizado con tu cuenta');
  await closeAccount(page);
}
async function sync(page: Page, expected: 'synced' | 'conflict' = 'synced') {
  const panel = await openAccount(page);
  const button = panel.getByRole('button', { name: 'Sincronizar ahora', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  if (expected === 'synced') await expect(panel.locator('.cloud-status')).toContainText('Sincronizado con tu cuenta');
  else await expect(panel.locator('.cloud-conflict')).toHaveCount(1);
  return panel;
}
function available(page: Page) { return page.locator('.stat-card').filter({ hasText: 'Disponible para ti' }).locator('.stat-value'); }
async function navigate(page: Page, name: string) {
  await closeAccount(page);
  const button = page.getByRole('button', { name, exact: true });
  const menu = page.getByRole('button', { name: 'Abrir menú', exact: true });
  if (await menu.isVisible() && !(await page.locator('.sidebar').evaluate(element => element.classList.contains('open')))) await menu.click();
  await button.click();
}
async function addExpense(page: Page, name: string, amount: number) {
  await closeAccount(page);
  await page.getByRole('button', { name: 'Nuevo movimiento', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Concepto', { exact: true }).fill(name);
  await dialog.getByLabel('Monto (USD)', { exact: true }).fill(String(amount));
  await dialog.getByLabel('Fecha', { exact: true }).fill('2026-11-10');
  await dialog.getByRole('button', { name: 'Añadir gasto', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function editExpense(page: Page, name: string, amount: number) {
  await navigate(page, 'Movimientos');
  await page.getByRole('button', { name: `Editar ${name}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Monto (EUR)', { exact: true }).fill(String(amount));
  await dialog.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function legacy(page: Page) { return page.evaluate(([finance, prefs]) => [localStorage.getItem(finance), localStorage.getItem(prefs)], [FINANCE_KEY, PREF_KEY]); }

test('un ingreso del celular llega a la computadora con originales USD/NIO/EUR y conserva la copia local', async ({ browser }) => {
  const cloud = new MockPrivateCloud();
  const phone = await device(browser, cloud, sourceData, true);
  const computer = await device(browser, cloud);
  try {
    const originalPhoneStorage = await legacy(phone.page);
    const originalComputerStorage = await legacy(computer.page);
    await activate(phone.page, true);
    await expect(available(phone.page)).toHaveText('$2,437.50');
    await activate(computer.page, false);
    await expect(available(computer.page)).toHaveText('$2,437.50');
    expect(cloud.account().get('income:salary')?.payload).toEqual(sourceData.incomes[0]);
    expect(cloud.account().get('expense:rent')?.payload).toEqual(sourceData.expenses[0]);
    expect(cloud.account().get('expense:euros')?.payload).toEqual(sourceData.expenses[1]);
    expect(cloud.account().get('goal:trip')?.payload).toEqual(sourceData.goals[0]);
    await addExpense(computer.page, 'Compra agregada desde computadora', 20);
    await sync(computer.page); await closeAccount(computer.page);
    await sync(phone.page); await closeAccount(phone.page);
    await expect(available(phone.page)).toHaveText('$2,417.50');
    await expect(available(computer.page)).toHaveText('$2,417.50');
    expect(await legacy(phone.page)).toEqual(originalPhoneStorage);
    expect(await legacy(computer.page)).toEqual(originalComputerStorage);
    expect(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await phone.context.close(); await computer.context.close(); }
});

test('un cambio sin conexión sobrevive recarga y una confirmación perdida no duplica la escritura', async ({ browser }) => {
  const cloud = new MockPrivateCloud();
  const phone = await device(browser, cloud, sourceData, true);
  try {
    await activate(phone.page, true);
    cloud.unavailable.add(phone.context);
    await phone.context.setOffline(true);
    await addExpense(phone.page, 'Compra guardada sin conexión', 25);
    await expect(available(phone.page)).toHaveText('$2,412.50');
    expect(cloud.liveRows().filter(row => (row.payload as { name?: string })?.name === 'Compra guardada sin conexión')).toHaveLength(0);
    await phone.context.setOffline(false);
    // Application assets reload from Vite; the private API remains unavailable.
    await phone.page.reload();
    await phone.page.getByLabel('Mes del resumen').fill('2026-11');
    await expect(available(phone.page)).toHaveText('$2,412.50');
    cloud.loseNextAcknowledgementFor = ALICE_ID;
    cloud.unavailable.delete(phone.context);
    let panel = await openAccount(phone.page);
    const synchronize = panel.getByRole('button', { name: 'Sincronizar ahora', exact: true });
    await expect(synchronize).toBeEnabled(); await synchronize.click();
    await expect.poll(() => cloud.liveRows().filter(row => (row.payload as { name?: string })?.name === 'Compra guardada sin conexión').length).toBe(1);
    // Retry an operation whose server transaction committed but reply was lost.
    panel = await sync(phone.page);
    const row = cloud.liveRows().find(row => (row.payload as { name?: string })?.name === 'Compra guardada sin conexión')!;
    expect(row.revision).toBe(1);
    const requestIds = cloud.requests.filter(request => request.changes.some(change => change.entity_id === row.entity_id)).map(request => request.operation);
    expect(requestIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(requestIds).size).toBe(1);
    await expect(panel.locator('.cloud-status')).toContainText('Sincronizado con tu cuenta');
  } finally { await phone.context.close(); }
});

test('dos ediciones concurrentes requieren elección y cerrar sesión aísla cuentas y registros locales', async ({ browser }) => {
  const cloud = new MockPrivateCloud();
  const phone = await device(browser, cloud, sourceData, true);
  const computer = await device(browser, cloud);
  try {
    await activate(phone.page, true); await activate(computer.page, false);
    const originalComputerStorage = await legacy(computer.page);
    cloud.unavailable.add(phone.context); cloud.unavailable.add(computer.context);
    await phone.context.setOffline(true); await computer.context.setOffline(true);
    await editExpense(phone.page, 'Compra original EUR', 60);
    await editExpense(computer.page, 'Compra original EUR', 70);
    await phone.context.setOffline(false); cloud.unavailable.delete(phone.context);
    await sync(phone.page); await closeAccount(phone.page);
    await computer.context.setOffline(false); cloud.unavailable.delete(computer.context);
    const panel = await sync(computer.page, 'conflict');
    const conflict = panel.locator('.cloud-conflict');
    await expect(conflict).toContainText('Compra original EUR');
    await expect(conflict).toContainText('70 EUR'); await expect(conflict).toContainText('60 EUR');
    await conflict.getByRole('button', { name: 'Conservar versión de la nube', exact: true }).click();
    await sync(computer.page); await closeAccount(computer.page);
    expect((cloud.account().get('expense:euros')?.payload as { amount: number }).amount).toBe(60);
    expect(await legacy(computer.page)).toEqual(originalComputerStorage);
    let account = await openAccount(computer.page);
    await account.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await expect(account.getByLabel('Correo electrónico', { exact: true })).toBeVisible();
    await navigate(computer.page, 'Resumen general');
    await expect(available(computer.page)).toHaveText('$0.00');
    await activate(computer.page, false, BOB);
    await expect(available(computer.page)).toHaveText('$0.00');
    await addExpense(computer.page, 'Gasto privado de Bob', 9);
    await sync(computer.page); await closeAccount(computer.page);
    expect(cloud.liveRows(BOB_ID).some(row => (row.payload as { name?: string })?.name === 'Gasto privado de Bob')).toBe(true);
    expect(cloud.liveRows(ALICE_ID).some(row => (row.payload as { name?: string })?.name === 'Gasto privado de Bob')).toBe(false);
    account = await openAccount(computer.page);
    await account.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await account.getByLabel('Correo electrónico', { exact: true }).fill(ALICE);
    await account.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
    await account.getByRole('button', { name: 'Entrar a mi cuenta', exact: true }).click();
    await expect(account.locator('.cloud-status')).toContainText('Sincronizado con tu cuenta');
    await navigate(computer.page, 'Resumen general');
    await expect(available(computer.page)).toHaveText('$2,425.00');
    expect(await legacy(computer.page)).toEqual(originalComputerStorage);
  } finally { await phone.context.close(); await computer.context.close(); }
});
