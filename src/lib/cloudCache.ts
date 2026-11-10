import { createBackup } from './backup';
import { normalizeSyncRows, type SyncChange, type SyncDocument, type SyncRow } from './syncModel';

export interface PendingCloudOperation { id: string; changes: SyncChange[] }
export interface CloudCache {
  version: 1;
  owner: string;
  document: SyncDocument;
  baseRows: SyncRow[];
  pendingOperation?: PendingCloudOperation;
  lastSynced: string | null;
}

export function canonicalDocument(document: SyncDocument): SyncDocument {
  const checked = createBackup(document.data, document.preferences);
  return { data: checked.data, preferences: { ...checked.preferences, demo: false } };
}

export function documentSignature(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(documentSignature).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${documentSignature(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function validateCloudCache(value: unknown, owner: string): CloudCache {
  const input = value as CloudCache;
  if (!input || input.version !== 1 || input.owner !== owner || !input.document) throw new Error('La copia de esta cuenta no es válida. Conservá un respaldo antes de continuar.');
  const document = canonicalDocument(input.document);
  const baseRows = normalizeSyncRows(input.baseRows);
  if (input.lastSynced !== null && (typeof input.lastSynced !== 'string' || !Number.isFinite(Date.parse(input.lastSynced)))) throw new Error('La fecha de sincronización guardada no es válida.');
  let pendingOperation: PendingCloudOperation | undefined;
  if (input.pendingOperation !== undefined) {
    const pending = input.pendingOperation;
    if (!pending || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(pending.id)
      || !Array.isArray(pending.changes) || !pending.changes.length || pending.changes.length > 500) throw new Error('La cola pendiente de esta cuenta no es válida.');
    const rows = normalizeSyncRows(pending.changes.map(change => ({ ...change, revision: change.expected_revision })));
    pendingOperation = { id: pending.id, changes: rows.map((row, index) => ({
      entity_type: row.entity_type, entity_id: row.entity_id, payload: row.payload,
      deleted: row.deleted, expected_revision: pending.changes[index].expected_revision,
    })) };
  }
  return { version: 1, owner, document, baseRows, lastSynced: input.lastSynced, ...(pendingOperation ? { pendingOperation } : {}) };
}

export function readCloudCache(storage: Pick<Storage, 'getItem'>, key: string, owner: string): CloudCache | null {
  const raw = storage.getItem(key);
  return raw === null ? null : validateCloudCache(JSON.parse(raw), owner);
}

/** One atomic storage item includes the current document and its unacknowledged operation. */
export function writeCloudCache(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string, cache: CloudCache): string {
  const serialized = JSON.stringify(validateCloudCache(cache, cache.owner));
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error('No se pudo comprobar el guardado local.');
  return serialized;
}

export function mergeAcknowledgedRows(baseRows: SyncRow[], acknowledged: SyncRow[]): SyncRow[] {
  const index = new Map(baseRows.map(row => [`${row.entity_type}:${row.entity_id}`, row]));
  for (const row of acknowledged) index.set(`${row.entity_type}:${row.entity_id}`, row);
  return normalizeSyncRows([...index.values()]);
}
