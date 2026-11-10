import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDocument, documentSignature, mergeAcknowledgedRows, readCloudCache, validateCloudCache, writeCloudCache, type CloudCache } from '../src/lib/cloudCache';
import { splitSyncDocument } from '../src/lib/syncModel';

const snapshot = { usd: 40, eur: 50, rateType: 'sell' as const, provider: 'manual' as const, date: '2026-11-10', fetchedAt: '2026-11-10T18:00:00.000Z', dateKind: 'effective' as const };
const document = {
  data: { incomes: [{ id: 'pay', name: 'Salario', amount: 3000.1234, currency: 'USD' as const, category: 'Salario', date: '2026-11-01', frequency: 'monthly' as const, exchangeRate: snapshot }], expenses: [], goals: [], savingsAmount: 300, savingsCurrency: 'EUR' as const, savingsExchangeRate: snapshot },
  preferences: { currency: 'NIO' as const, demo: false },
};
const rows = splitSyncDocument(document).map(row => ({ ...row, revision: 1 }));
function cache(): CloudCache { return { version: 1, owner: 'owner-a', document: structuredClone(document), baseRows: rows, lastSynced: null }; }
function memory() {
  const records = new Map<string, string>();
  return { records, getItem(key: string) { return records.get(key) ?? null; }, setItem(key: string, value: string) { records.set(key, value); } };
}

test('owner-scoped cache retains original amounts, currencies and complete captured rates', () => {
  const store = memory();
  writeCloudCache(store, 'project:owner-a', cache());
  const restored = readCloudCache(store, 'project:owner-a', 'owner-a')!;
  assert.deepEqual(restored.document, document);
  assert.equal(restored.document.data.incomes[0].amount, 3000.1234);
  assert.equal(restored.document.data.savingsCurrency, 'EUR');
  assert.throws(() => readCloudCache(store, 'project:owner-a', 'owner-b'));
  assert.equal(readCloudCache(store, 'project:owner-b', 'owner-b'), null);
});

test('durable outbox round trip retains the same operation id and expected revision', () => {
  const pending = cache();
  pending.pendingOperation = { id: '11111111-2222-4333-8444-555555555555', changes: [{ entity_type: 'income', entity_id: 'pay', payload: document.data.incomes[0], deleted: false, expected_revision: 7 }] };
  const store = memory();
  writeCloudCache(store, 'account', pending);
  const restored = readCloudCache(store, 'account', 'owner-a')!;
  assert.deepEqual(restored.pendingOperation, pending.pendingOperation);
  assert.equal(restored.pendingOperation?.changes[0].expected_revision, 7);
});

test('malformed pending operations or a mismatched record id are rejected before storage writes', () => {
  const store = memory();
  const original = writeCloudCache(store, 'account', cache());
  for (const operation of [
    { id: 'not-a-uuid', changes: [] },
    { id: '11111111-2222-4333-8444-555555555555', changes: [{ entity_type: 'income', entity_id: 'other', payload: document.data.incomes[0], deleted: false, expected_revision: 1 }] },
    { id: '11111111-2222-4333-8444-555555555555', changes: [{ entity_type: 'income', entity_id: 'pay', payload: document.data.incomes[0], deleted: false, expected_revision: -1 }] },
  ]) {
    assert.throws(() => writeCloudCache(store, 'account', { ...cache(), pendingOperation: operation } as CloudCache));
    assert.equal(store.getItem('account'), original);
  }
});

test('storage quota failures keep the previous atomic document and operation together', () => {
  const store = memory();
  const original = writeCloudCache(store, 'account', cache());
  const full = { getItem: store.getItem, setItem() { throw new DOMException('full', 'QuotaExceededError'); } };
  assert.throws(() => writeCloudCache(full, 'account', { ...cache(), document: { ...document, data: { ...document.data, savingsAmount: 999 } } }));
  assert.equal(store.getItem('account'), original);
});

test('acknowledging a partial batch preserves unrelated rows and deletion tombstones', () => {
  const base = [...rows, { entity_type: 'expense' as const, entity_id: 'deleted-purchase', payload: null, deleted: true, revision: 5 }];
  const updated = { ...rows[0], revision: 2, payload: { ...document.data.incomes[0], amount: 3100 } };
  const merged = mergeAcknowledgedRows(base, [updated]);
  assert.equal(merged.length, base.length);
  assert.equal(merged.find(row => row.entity_id === 'pay')?.revision, 2);
  assert.deepEqual(merged.find(row => row.entity_id === 'deleted-purchase'), base.at(-1));
});

test('cache validation rejects future versions and canonicalization excludes demo mode', () => {
  assert.throws(() => validateCloudCache({ ...cache(), version: 2 }, 'owner-a'));
  assert.equal(canonicalDocument({ ...document, preferences: { demo: true } }).preferences.demo, false);
  assert.equal(documentSignature({ a: 1, b: { y: 2, z: 3 } }), documentSignature({ b: { z: 3, y: 2 }, a: 1 }));
});
