// Isolated PostgreSQL validation with PGlite. This never contacts a Supabase project.
// PGLITE_MODULE can point to a temporary installation's dist/index.js.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const op = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const income = (id, amount = 3000) => ({ id, name: `Ingreso ${id}`, amount, category: 'Salario', date: '2026-11-10', frequency: 'monthly', currency: 'USD' });
const expense = (id, amount = 800) => ({ id, name: `Egreso ${id}`, amount, category: 'Vivienda', date: '2026-11-10', kind: 'fixed', frequency: 'monthly', currency: 'USD' });
const change = (type, id, payload, revision = 0) => ({ entity_type: type, entity_id: id, payload, deleted: payload === null, expected_revision: revision });
const apply = async (operation, changes) => (await db.query('select public.konten_apply_changes($1::uuid, $2::jsonb) as result', [op(operation), JSON.stringify(changes)])).rows[0].result;
const records = async () => (await db.query('select * from public.konten_records order by entity_type, entity_id')).rows;
async function asUser(user) {
  await db.exec('reset role; set role authenticated;');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? '']);
}
const denied = (action) => assert.rejects(action, error => error.code === '42501');
const invalid = (action) => assert.rejects(action, error => typeof error.code === 'string' && error.code.startsWith('22'));

// Minimal auth stubs only in this empty in-memory database. Supabase provides
// auth.users/auth.uid() and these roles itself; do not deploy these stubs.
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  insert into auth.users values ('${userA}'), ('${userB}');
`);
await db.exec(await readFile(new URL('../migrations/202611100001_private_sync.sql', import.meta.url), 'utf8'));

await test('anonymous and unsigned authenticated requests cannot access records or write through RPC', async () => {
  await db.exec('set role anon;');
  await denied(() => records());
  await denied(() => apply(1, [change('income', 'salary', income('salary'))]));
  await asUser(null);
  await denied(() => apply(1, [change('income', 'salary', income('salary'))]));
});

await test('authenticated owner writes only through RPC and reads only their own records', async () => {
  await asUser(userA);
  const result = await apply(2, [change('income', 'salary', income('salary'))]);
  assert.equal(result.applied, true);
  assert.equal(result.rows[0].revision, 1);
  assert.equal(result.rows[0].user_id, userA);
  assert.equal(result.rows[0].payload.amount, 3000);
  assert.ok(Date.parse(result.rows[0].updated_at));
  await denied(() => db.query("update public.konten_records set revision=99 where entity_id='salary'"));
  await denied(() => db.query('delete from public.konten_records'));
  await denied(() => db.query('select * from public.konten_sync_receipts'));
  await asUser(userB);
  assert.deepEqual(await records(), []);
  await apply(3, [change('income', 'salary', income('salary', 2000))]);
  assert.equal((await records())[0].payload.amount, 2000);
  await asUser(userA);
  assert.equal((await records())[0].payload.amount, 3000);
  assert.deepEqual((await db.query('select * from public.konten_records where user_id=$1', [userB])).rows, []);
});

await test('successful retries are idempotent and operation IDs cannot be reused with changed content', async () => {
  await asUser(userA);
  const changes = [change('expense', 'rent', expense('rent'))];
  const first = await apply(4, changes);
  assert.deepEqual(await apply(4, changes), first);
  assert.equal((await records()).find(row => row.entity_id === 'rent').revision, 1);
  await invalid(() => apply(4, [change('expense', 'rent', expense('rent', 900))]));
  assert.equal((await records()).find(row => row.entity_id === 'rent').payload.amount, 800);
});

await test('stale revisions reject the entire batch without losing another device edit', async () => {
  await asUser(userA);
  const firstDevice = await apply(5, [change('expense', 'rent', expense('rent', 850), 1)]);
  assert.equal(firstDevice.rows[0].revision, 2);
  const staleDevice = await apply(6, [change('expense', 'rent', expense('rent', 900), 1), change('income', 'must-not-exist', income('must-not-exist'))]);
  assert.equal(staleDevice.applied, false);
  assert.deepEqual(staleDevice.rows, []);
  assert.equal(staleDevice.conflicts[0].payload.amount, 850);
  assert.equal(staleDevice.conflicts[0].revision, 2);
  const rows = await records();
  assert.equal(rows.some(row => row.entity_id === 'must-not-exist'), false);
  assert.equal(rows.find(row => row.entity_id === 'rent').payload.amount, 850);
});

await test('independent new records from two device snapshots are both retained', async () => {
  await asUser(userA);
  assert.equal((await apply(7, [change('expense', 'food', expense('food', 200))])).applied, true);
  assert.equal((await apply(8, [change('income', 'extra', income('extra', 500))])).applied, true);
  assert.equal((await records()).filter(row => ['food', 'extra'].includes(row.entity_id)).length, 2);
});

await test('tombstones prevent a stale edit from resurrecting a deletion', async () => {
  await asUser(userA);
  const removed = await apply(9, [change('expense', 'food', null, 1)]);
  assert.equal(removed.rows[0].deleted, true);
  assert.equal(removed.rows[0].payload, null);
  assert.equal(removed.rows[0].revision, 2);
  const stale = await apply(10, [change('expense', 'food', expense('food', 250), 1)]);
  assert.equal(stale.applied, false);
  assert.equal(stale.conflicts[0].deleted, true);
  assert.equal((await records()).find(row => row.entity_id === 'food').deleted, true);
});

await test('a missing expected record produces an explicit revision-zero conflict', async () => {
  const result = await apply(11, [change('income', 'missing', income('missing'), 2)]);
  assert.equal(result.applied, false);
  assert.equal(result.conflicts[0].revision, 0);
  assert.equal(result.conflicts[0].updated_at, null);
  assert.equal(result.conflicts[0].deleted, true);
});

await test('invalid owner fields, IDs, duplicate rows, amounts, dates, currencies and oversized batches do not write', async () => {
  const before = await records();
  await invalid(() => apply(12, [{ ...change('income', 'invalid', income('invalid')), user_id: userB }]));
  await invalid(() => apply(13, [change('income', 'invalid', income('different'))]));
  await invalid(() => apply(14, [change('income', 'invalid', income('invalid')), change('income', 'invalid', income('invalid'))]));
  await invalid(() => apply(15, [change('income', 'invalid', income('invalid', -1))]));
  await invalid(() => apply(16, [change('income', 'invalid', { ...income('invalid'), currency: 'MXN' })]));
  await invalid(() => apply(17, [change('income', 'invalid', { ...income('invalid'), date: '2026-02-30' })]));
  await invalid(() => apply(18, [change('income', 'invalid', { ...income('invalid'), name: 'a'.repeat(70000) })]));
  await invalid(() => apply(19, Array.from({ length: 501 }, (_, index) => change('income', `many${index}`, income(`many${index}`)))));
  await invalid(() => apply(20, []));
  await invalid(() => apply(22, [change('budget', 'other', { savingsAmount: 100 })]));
  await invalid(() => apply(23, [change('preferences', 'other', { currency: 'USD' })]));
  assert.deepEqual(await records(), before);
});

await test('currency amounts and captured references survive budget and movement storage unchanged', async () => {
  const snapshot = { usd: 40, eur: 50, rateType: 'sell', provider: 'manual', date: '2026-11-10', fetchedAt: '2026-11-10T12:00:00.000Z', dateKind: 'effective' };
  const payload = { ...income('nio', 4000), currency: 'NIO', exchangeRate: snapshot };
  const budget = { savingsAmount: 300, savingsCurrency: 'USD', legacyCurrency: 'USD', savingsExchangeRate: snapshot };
  const result = await apply(21, [change('income', 'nio', payload), change('budget', 'main', budget), change('preferences', 'main', { currency: 'EUR', rateType: 'sell', demo: false })]);
  assert.equal(result.applied, true);
  assert.deepEqual(result.rows.find(row => row.entity_type === 'income').payload, payload);
  assert.deepEqual(result.rows.find(row => row.entity_type === 'budget').payload, budget);
  await asUser(userB);
  assert.equal((await records()).some(row => row.entity_id === 'nio'), false);
});

await db.close();
