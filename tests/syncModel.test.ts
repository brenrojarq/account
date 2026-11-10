import test from 'node:test';
import assert from 'node:assert/strict';
import {
  materializeSyncRows, normalizeSyncRows, planSync, resolveSyncConflicts,
  splitSyncDocument, syncRowKey, type SyncDocument, type SyncRow,
} from '../src/lib/syncModel.ts';
import type { CurrencyRateSnapshot } from '../src/lib/currency.ts';

// Synthetic entries and manual rates; never access real browser/account data.
const rate: CurrencyRateSnapshot = {
  usd: 40, eur: 50, rateType: 'sell', provider: 'manual', date: '2026-11-10',
  fetchedAt: '2026-11-10T15:00:00.000Z', dateKind: 'effective',
};

function fixture(): SyncDocument {
  return {
    data: {
      legacyCurrency: 'USD', savingsAmount: 123.4567, savingsCurrency: 'EUR', savingsExchangeRate: structuredClone(rate),
      incomes: [{ id: 'salary', name: 'Salario', amount: 1500.1234, frequency: 'biweekly', date: '2026-01-01', category: 'Salario', currency: 'USD', exchangeRate: structuredClone(rate) }],
      expenses: [{ id: 'course', name: 'Curso', amount: 89.12345, kind: 'variable', category: 'Educación', date: '2026-11-06', currency: 'EUR' }],
      goals: [{ id: 'trip', name: 'Viaje', target: 8000, saved: 215.45, monthly: 25, currency: 'NIO', exchangeRate: structuredClone(rate), color: '#087f46' }],
    },
    preferences: { currency: 'NIO', rateType: 'sell', chart: 'scatter', cards: ['available', 'income'], showTransactions: true, showGoals: false, demo: false },
  };
}

function persisted(document = fixture(), revision = 1): SyncRow[] {
  return splitSyncDocument(document).map(row => ({ ...row, revision, updated_at: '2026-11-10T15:00:00+00:00' }));
}

function withRemoteChange(rows: SyncRow[], key: string, payload: unknown, deleted = false): SyncRow[] {
  return rows.map(row => syncRowKey(row) === key ? { ...row, payload: structuredClone(payload), deleted, revision: row.revision + 1 } : structuredClone(row));
}

test('split and materialize retain exact original numbers, currencies, goals and captured rates without mutation', () => {
  const original = fixture();
  const before = structuredClone(original);
  const rows = splitSyncDocument(original);
  assert.equal(rows.length, 5);
  assert.deepEqual(materializeSyncRows(rows), original);
  assert.equal(materializeSyncRows(rows).data.expenses[0].amount, 89.12345);
  assert.equal(materializeSyncRows(rows).data.savingsAmount, 123.4567);
  assert.deepEqual(original, before);
  (rows[0].payload as { amount: number }).amount = 999;
  assert.equal(original.data.incomes[0].amount, 1500.1234, 'rows never alias the source records');
});

test('independent concurrent additions from two devices merge instead of replacing an account', () => {
  const base = persisted();
  const local = fixture();
  local.data.incomes.push({ ...local.data.incomes[0], id: 'extra', name: 'Trabajo extra', amount: 50 });
  const remoteDocument = fixture();
  remoteDocument.data.expenses.push({ ...remoteDocument.data.expenses[0], id: 'food', name: 'Comida', amount: 120, currency: 'NIO' });
  const remote = persisted(remoteDocument);
  const before = structuredClone({ base, local, remote });
  const plan = planSync(base, local, remote);
  assert.equal(plan.conflicts.length, 0);
  assert.deepEqual(plan.document.data.incomes.map(item => item.id).sort(), ['extra', 'salary']);
  assert.deepEqual(plan.document.data.expenses.map(item => item.id).sort(), ['course', 'food']);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].entity_id, 'extra');
  assert.equal(plan.changes[0].expected_revision, 0);
  assert.deepEqual({ base, local, remote }, before);
});

test('concurrent edits preserve both versions and require an explicit choice with the latest revision', () => {
  const base = persisted();
  const local = fixture();
  local.data.incomes[0].amount = 1600;
  const remote = withRemoteChange(base, 'income:salary', { ...fixture().data.incomes[0], amount: 1700 });
  const plan = planSync(base, local, remote);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].key, 'income:salary');
  assert.equal(plan.document.data.incomes[0].amount, 1600);
  assert.equal((plan.conflicts[0].remote!.payload as { amount: number }).amount, 1700);
  assert.equal(plan.changes.length, 0, 'never silently upload the local conflict version');
  const useRemote = resolveSyncConflicts(plan, { 'income:salary': 'remote' });
  assert.equal(useRemote.document.data.incomes[0].amount, 1700);
  assert.equal(useRemote.changes.length, 0);
  assert.equal(useRemote.conflicts.length, 0);
  const useLocal = resolveSyncConflicts(plan, { 'income:salary': 'local' });
  assert.equal(useLocal.document.data.incomes[0].amount, 1600);
  assert.equal(useLocal.changes[0].expected_revision, 2);
  assert.equal((useLocal.changes[0].payload as { amount: number }).amount, 1600);
  assert.equal(useLocal.conflicts.length, 0);
  assert.equal(plan.conflicts.length, 1, 'choosing a version never mutates the saved conflict plan');
});

test('a local deletion conflicts with a newer remote edit and either choice remains available', () => {
  const base = persisted();
  const local = fixture();
  local.data.incomes = [];
  const remote = withRemoteChange(base, 'income:salary', { ...fixture().data.incomes[0], name: 'Sueldo actualizado' });
  const plan = planSync(base, local, remote);
  assert.equal(plan.conflicts[0].local, null);
  assert.equal(plan.document.data.incomes.length, 0);
  const useRemote = resolveSyncConflicts(plan, { 'income:salary': 'remote' });
  assert.equal(useRemote.document.data.incomes[0].name, 'Sueldo actualizado');
  assert.equal(useRemote.changes.length, 0);
  const useLocal = resolveSyncConflicts(plan, { 'income:salary': 'local' });
  assert.deepEqual(useLocal.changes, [{ entity_type: 'income', entity_id: 'salary', payload: null, deleted: true, expected_revision: 2 }]);
});

test('a remote tombstone prevents resurrection unless the owner explicitly keeps a conflicting local edit', () => {
  const base = persisted();
  const remote = withRemoteChange(base, 'income:salary', null, true);
  const unchanged = planSync(base, fixture(), remote);
  assert.equal(unchanged.document.data.incomes.length, 0);
  assert.equal(unchanged.changes.length, 0);
  assert.equal(unchanged.conflicts.length, 0);
  const local = fixture();
  local.data.incomes[0].amount = 2000;
  const conflict = planSync(base, local, remote);
  assert.equal(conflict.conflicts[0].remote!.deleted, true);
  assert.equal(resolveSyncConflicts(conflict, { 'income:salary': 'remote' }).document.data.incomes.length, 0);
  const restore = resolveSyncConflicts(conflict, { 'income:salary': 'local' });
  assert.equal(restore.changes[0].deleted, false);
  assert.equal(restore.changes[0].expected_revision, 2);
  assert.equal((restore.changes[0].payload as { amount: number }).amount, 2000);
});

test('offline planning is repeatable and confirmed tombstones do not cause duplicate deletions', () => {
  const base = persisted();
  const local = fixture();
  local.data.expenses = [];
  const first = planSync(base, local, base);
  const retry = planSync(base, local, base);
  assert.deepEqual(retry, first);
  assert.deepEqual(first.changes, [{ entity_type: 'expense', entity_id: 'course', payload: null, deleted: true, expected_revision: 1 }]);
  const acknowledged = withRemoteChange(base, 'expense:course', null, true);
  const settled = planSync(acknowledged, local, acknowledged);
  assert.equal(settled.changes.length, 0);
  assert.equal(settled.document.data.expenses.length, 0);
});

test('identical edits and differences in object-key order converge without a conflict', () => {
  const base = persisted();
  const local = fixture();
  local.data.incomes[0].amount = 1800;
  const remotePayload = Object.fromEntries(Object.entries(local.data.incomes[0]).reverse());
  const remote = withRemoteChange(base, 'income:salary', remotePayload);
  const plan = planSync(base, local, remote);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.document.data.incomes[0].amount, 1800);
});

test('an empty unbased device never deletes cloud movements or goals', () => {
  const empty = materializeSyncRows([]);
  const remote = persisted();
  const plan = planSync([], empty, remote);
  assert.equal(plan.document.data.incomes[0].id, 'salary');
  assert.equal(plan.document.data.expenses[0].id, 'course');
  assert.equal(plan.document.data.goals[0].id, 'trip');
  assert.equal(plan.changes.some(change => change.deleted), false);
  // Without a base, a local zero reserve cannot be guessed to mean "delete cloud savings".
  assert.equal(plan.conflicts.some(conflict => conflict.key === 'budget:main'), true);
});

test('budget and preferences conflicts stay independent and savings are never summed', () => {
  const base = persisted();
  const local = fixture();
  local.data.savingsAmount = 400;
  local.preferences.currency = 'EUR';
  let remote = withRemoteChange(base, 'budget:main', { ...fixture().data, incomes: undefined, expenses: undefined, goals: undefined, savingsAmount: 600 });
  remote = withRemoteChange(remote, 'preferences:main', { ...fixture().preferences, currency: 'USD' });
  const plan = planSync(base, local, remote);
  assert.deepEqual(plan.conflicts.map(conflict => conflict.key).sort(), ['budget:main', 'preferences:main']);
  const partial = resolveSyncConflicts(plan, { 'budget:main': 'remote' });
  assert.equal(partial.document.data.savingsAmount, 600);
  assert.equal(partial.conflicts.length, 1);
  assert.equal(partial.conflicts[0].key, 'preferences:main');
  const resolved = resolveSyncConflicts(partial, { 'preferences:main': 'local' });
  assert.equal(resolved.document.data.savingsAmount, 600);
  assert.equal(resolved.document.preferences.currency, 'EUR');
  assert.equal(resolved.changes.length, 1);
  assert.equal(resolved.changes[0].entity_type, 'preferences');
  assert.equal(resolved.changes[0].expected_revision, 2);
});

test('remote rows, RPC partial batches and missing-row conflicts are validated before use', () => {
  const rows = persisted();
  const partial = normalizeSyncRows([rows[0]]);
  assert.equal(partial.length, 1);
  assert.deepEqual(partial[0], rows[0]);
  assert.deepEqual(normalizeSyncRows([{ entity_type: 'budget', entity_id: 'main', payload: null, revision: 0, deleted: true, updated_at: null }]),
    [{ entity_type: 'budget', entity_id: 'main', payload: null, revision: 0, deleted: true, updated_at: null }]);
  const invalid: unknown[] = [
    null,
    [rows[0], rows[0]],
    [{ ...rows[0], revision: -1 }],
    [{ ...rows[0], revision: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...rows[0], deleted: 'false' }],
    [{ ...rows[0], deleted: true }],
    [{ ...rows[0], entity_type: 'session' }],
    [{ ...rows[0], entity_id: 'another-id' }],
    [{ ...rows[0], updated_at: 'not a timestamp' }],
    [{ ...rows[0], payload: { ...(rows[0].payload as object), amount: Infinity } }],
    [{ ...rows[0], payload: { ...(rows[0].payload as object), currency: 'MXN' } }],
    [{ entity_type: 'budget', entity_id: 'other', payload: { savingsAmount: 0 }, revision: 1, deleted: false }],
  ];
  for (const value of invalid) assert.throws(() => normalizeSyncRows(value));
});

test('incomplete or stale cloud snapshots cannot masquerade as mass deletions or revert revisions', () => {
  const base = persisted();
  assert.throws(() => planSync(base, fixture(), base.filter(row => row.entity_id !== 'salary')), /incompleta/);
  const stale = base.map(row => ({ ...row, revision: 0 }));
  assert.throws(() => planSync(base, fixture(), stale), /revisión/);
  const incoherent = base.map(row => row.entity_id === 'salary' ? { ...row, payload: { ...(row.payload as object), amount: 999 } } : row);
  assert.throws(() => planSync(base, fixture(), incoherent), /revisión/);
});

test('legacy original-currency review survives and auth/unknown fields never enter shared rows', () => {
  const document = fixture();
  delete document.data.legacyCurrency;
  document.data.legacyCurrencyReview = 'MXN';
  delete document.data.incomes[0].currency;
  const extra = document as SyncDocument & { session?: string };
  extra.session = 'private-session';
  (extra.preferences as Record<string, unknown>).auth = 'private-session';
  const rows = splitSyncDocument(extra);
  assert.equal(JSON.stringify(rows).includes('private-session'), false);
  const restored = materializeSyncRows(rows);
  assert.equal(restored.data.legacyCurrencyReview, 'MXN');
  assert.equal(restored.data.incomes[0].currency, undefined);
  assert.equal(restored.data.incomes[0].amount, 1500.1234);
});

test('default preferences never leak through mutable references or enable shared demo mode', () => {
  const first = materializeSyncRows([]);
  first.preferences.cards!.push('corrupted');
  const second = materializeSyncRows([]);
  assert.deepEqual(second.preferences.cards, ['income', 'fixed', 'savings', 'available']);
  const local = fixture();
  local.preferences.demo = true;
  assert.equal(materializeSyncRows(splitSyncDocument(local)).preferences.demo, false);
});
