import { createBackup, type BackupFinanceData, type BackupPreferences } from './backup';

export type SyncEntityType = 'income' | 'expense' | 'goal' | 'budget' | 'preferences';

/** A full owner-scoped snapshot includes tombstones, including previous deletions. */
export interface SyncRow {
  entity_type: SyncEntityType;
  entity_id: string;
  payload: unknown | null;
  revision: number;
  deleted: boolean;
  updated_at?: string | null;
}

export interface SyncChange {
  entity_type: SyncEntityType;
  entity_id: string;
  payload: unknown | null;
  deleted: boolean;
  expected_revision: number;
}

export interface SyncDocument {
  data: BackupFinanceData;
  preferences: BackupPreferences;
}

export interface SyncConflict {
  key: string;
  /** null means the local version deleted or does not contain this record. */
  local: SyncRow | null;
  /** null means the server has never contained this record. */
  remote: SyncRow | null;
}

export interface SyncPlan {
  /** Conflict records keep the local version here until the owner chooses. */
  document: SyncDocument;
  /** Only dispatch when conflicts is empty; a server batch is transactional. */
  changes: SyncChange[];
  conflicts: SyncConflict[];
}

const validationDate = new Date('2026-01-01T00:00:00.000Z');
const entityTypes: readonly SyncEntityType[] = ['income', 'expense', 'goal', 'budget', 'preferences'];
const defaultPreferences: Required<BackupPreferences> = {
  currency: 'USD', rateType: 'sell', chart: 'pie',
  cards: ['income', 'fixed', 'savings', 'available'],
  showTransactions: true, showGoals: true, demo: false,
};

export function syncRowKey(row: Pick<SyncRow, 'entity_type' | 'entity_id'>): string {
  return `${row.entity_type}:${row.entity_id}`;
}

function fail(detail: string): never {
  throw new Error(`Los datos de sincronización no son válidos: ${detail}.`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanDocument(document: SyncDocument): SyncDocument {
  const validated = createBackup(document.data, document.preferences, undefined, validationDate);
  return {
    data: validated.data,
    // Example data is a device-only mode, never a shared account preference.
    preferences: { ...structuredClone(defaultPreferences), ...validated.preferences, demo: false },
  };
}

function splitValidatedDocument(document: SyncDocument): SyncRow[] {
  const { incomes, expenses, goals, ...budget } = document.data;
  const row = (entity_type: SyncEntityType, entity_id: string, payload: unknown): SyncRow => ({
    entity_type, entity_id, payload: structuredClone(payload), revision: 0, deleted: false,
  });
  return [
    ...incomes.map(item => row('income', item.id, item)),
    ...expenses.map(item => row('expense', item.id, item)),
    ...goals.map(item => row('goal', item.id, item)),
    row('budget', 'main', budget), row('preferences', 'main', document.preferences),
  ];
}

/** Original amounts, currencies and captured rates are copied without conversion. */
export function splitSyncDocument(document: SyncDocument): SyncRow[] {
  return splitValidatedDocument(cleanDocument(document));
}

function rowEnvelopes(value: unknown): SyncRow[] {
  if (!Array.isArray(value)) fail('se esperaba una lista completa de registros');
  const seen = new Set<string>();
  return value.map((input: unknown) => {
    if (!isObject(input) || !entityTypes.includes(input.entity_type as SyncEntityType)) fail('tipo de registro desconocido');
    if (typeof input.entity_id !== 'string' || !input.entity_id.trim() || input.entity_id.length > 200) fail('identificador de registro');
    const entity_type = input.entity_type as SyncEntityType;
    if ((entity_type === 'budget' || entity_type === 'preferences') && input.entity_id !== 'main') fail('identificador de ajustes');
    if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0) fail('revisión de registro');
    if (typeof input.deleted !== 'boolean') fail('estado de eliminación');
    if (input.deleted ? input.payload !== null : !isObject(input.payload)) fail('contenido del registro');
    if (!input.deleted && ['income', 'expense', 'goal'].includes(entity_type)
      && (input.payload as Record<string, unknown>).id !== input.entity_id) fail('el identificador no coincide con su contenido');
    if (input.updated_at !== undefined && input.updated_at !== null
      && (typeof input.updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(input.updated_at) || !Number.isFinite(Date.parse(input.updated_at)))) fail('fecha del servidor');
    const row: SyncRow = {
      entity_type, entity_id: input.entity_id, payload: structuredClone(input.payload),
      revision: input.revision, deleted: input.deleted,
      ...(input.updated_at !== undefined ? { updated_at: input.updated_at as string | null } : {}),
    };
    const key = syncRowKey(row);
    if (seen.has(key)) fail('registro duplicado');
    seen.add(key);
    return row;
  });
}

function documentFromEnvelopes(rows: SyncRow[]): SyncDocument {
  const active = rows.filter(row => !row.deleted);
  const budget = active.find(row => row.entity_type === 'budget')?.payload ?? { savingsAmount: 0 };
  const preferences = active.find(row => row.entity_type === 'preferences')?.payload ?? {};
  return cleanDocument({
    // Arrays last: an untrusted budget payload cannot inject financial records.
    data: {
      ...(budget as object),
      incomes: active.filter(row => row.entity_type === 'income').map(row => row.payload),
      expenses: active.filter(row => row.entity_type === 'expense').map(row => row.payload),
      goals: active.filter(row => row.entity_type === 'goal').map(row => row.payload),
    } as BackupFinanceData,
    preferences: preferences as BackupPreferences,
  });
}

/** Validate cache/RPC/SELECT data before it can replace the current document. */
export function normalizeSyncRows(value: unknown): SyncRow[] {
  const rows = rowEnvelopes(value);
  const document = documentFromEnvelopes(rows);
  const canonical = new Map(splitValidatedDocument(document).map(row => [syncRowKey(row), row]));
  return rows.map(row => row.deleted ? row : { ...row, payload: canonical.get(syncRowKey(row))!.payload });
}

export function materializeSyncRows(rows: SyncRow[]): SyncDocument {
  return documentFromEnvelopes(rowEnvelopes(rows));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function sameContent(a: SyncRow | null | undefined, b: SyncRow | null | undefined): boolean {
  const left = a && !a.deleted ? a.payload : null;
  const right = b && !b.deleted ? b.payload : null;
  return stable(left) === stable(right);
}

function asChange(local: SyncRow | null, remote: SyncRow | null, reference: SyncRow): SyncChange {
  return {
    entity_type: reference.entity_type, entity_id: reference.entity_id,
    payload: local && !local.deleted ? structuredClone(local.payload) : null,
    deleted: !local || local.deleted, expected_revision: remote?.revision ?? 0,
  };
}

/**
 * Three-way merge by record, not by whole account. baseRows must be the last
 * acknowledged cloud snapshot; remoteRows must contain all rows and tombstones.
 * Missing local records delete only records that existed in that base.
 */
export function planSync(baseRows: SyncRow[], localDocument: SyncDocument, remoteRows: SyncRow[]): SyncPlan {
  const base = new Map(normalizeSyncRows(baseRows).map(row => [syncRowKey(row), row]));
  const local = new Map(splitSyncDocument(localDocument).map(row => [syncRowKey(row), row]));
  const remote = new Map(normalizeSyncRows(remoteRows).map(row => [syncRowKey(row), row]));
  for (const [key, old] of base) {
    const current = remote.get(key);
    if (!current && old.revision > 0) fail('la respuesta está incompleta; falta un registro o su eliminación');
    if (current && (current.revision < old.revision || current.revision === old.revision && !sameContent(current, old))) fail('la respuesta del servidor contiene una revisión anterior o incoherente');
  }
  const selected: SyncRow[] = [];
  const changes: SyncChange[] = [];
  const conflicts: SyncConflict[] = [];
  const keys = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  for (const key of keys) {
    const old = base.get(key) ?? null;
    const here = local.get(key) ?? null;
    const there = remote.get(key) ?? null;
    if (sameContent(here, there)) {
      if (there) selected.push(there);
    } else if (sameContent(here, old)) {
      if (there) selected.push(there);
    } else if (sameContent(there, old)) {
      if (here) selected.push(here);
      changes.push(asChange(here, there, here ?? there ?? old!));
    } else {
      conflicts.push({ key, local: here, remote: there });
      if (here) selected.push(here);
    }
  }
  return { document: materializeSyncRows(selected), changes, conflicts };
}

/** Choose one side explicitly; other unresolved conflicts remain intact. */
export function resolveSyncConflicts(plan: SyncPlan, choices: Record<string, 'local' | 'remote'>): SyncPlan {
  const rows = new Map(splitSyncDocument(plan.document).map(row => [syncRowKey(row), row]));
  const changes = structuredClone(plan.changes);
  const conflicts: SyncConflict[] = [];
  for (const conflict of plan.conflicts) {
    const choice = Object.hasOwn(choices, conflict.key) ? choices[conflict.key] : undefined;
    if (choice !== 'local' && choice !== 'remote') {
      conflicts.push(structuredClone(conflict));
      continue;
    }
    const selected = choice === 'local' ? conflict.local : conflict.remote;
    if (selected && !selected.deleted) rows.set(conflict.key, structuredClone(selected));
    else rows.delete(conflict.key);
    if (choice === 'local' && !sameContent(conflict.local, conflict.remote)) {
      changes.push(asChange(conflict.local, conflict.remote, (conflict.local ?? conflict.remote)!));
    }
  }
  return { document: materializeSyncRows([...rows.values()]), changes, conflicts };
}
