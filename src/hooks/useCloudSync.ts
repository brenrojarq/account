import { useEffect, useRef, useState } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { BackupFinanceData, BackupPreferences } from '../lib/backup';
import { applyCloudChanges, cloudConfiguration, cloudError, cloudFetch, cloudNamespace, fetchCloudRows, getCloudClient } from '../lib/cloudClient';
import { canonicalDocument, documentSignature, mergeAcknowledgedRows, readCloudCache, writeCloudCache, type CloudCache } from '../lib/cloudCache';
import { materializeSyncRows, planSync, resolveSyncConflicts, type SyncConflict, type SyncDocument, type SyncPlan, type SyncRow } from '../lib/syncModel';

type Phase = 'local' | 'loading' | 'migration' | 'syncing' | 'synced' | 'pending' | 'offline' | 'conflict' | 'error';
interface Migration { localCount: number; remoteCount: number; hasLocalData: boolean }
interface State {
  configured: boolean; email: string | null; isCloud: boolean; phase: Phase;
  error: string; feedback: string; lastSynced: string | null; pendingCount: number;
  busy: boolean; recovery: boolean; migration: Migration | null; conflicts: SyncConflict[];
  /** A second tab may view the account but must not mutate its shared durable outbox. */
  readOnly: boolean;
}
export interface CloudSyncState extends State {
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  signOut(): Promise<void>;
  activate(mode: 'import' | 'cloud'): Promise<void>;
  syncNow(): Promise<void>;
  resolveConflict(key: string, choice: 'local' | 'remote'): void;
}
interface Options {
  data: BackupFinanceData; preferences: BackupPreferences;
  onDocument(document: SyncDocument): void;
  onLocal(): void;
  deferSync?: boolean;
}
interface ActiveAccount { uid: string; key: string; cache: CloudCache | null; writable: boolean }
const emptyState = (configured: boolean): State => ({ configured, email: null, isCloud: false,
  phase: configured ? 'loading' : 'local', error: '', feedback: '', lastSynced: null,
  pendingCount: 0, busy: false, recovery: false, migration: null, conflicts: [], readOnly: false });
function count(document: SyncDocument) { return document.data.incomes.length + document.data.expenses.length + document.data.goals.length; }
function hasOwnData(document: SyncDocument) { return document.preferences.demo !== true && (count(document) > 0 || document.data.savingsAmount > 0); }
function redirectUrl() { const url = new URL('./', window.location.href); url.search = ''; url.hash = ''; return url.href; }
function storageProblem() { return 'No se pudo guardar la copia de tu cuenta en este navegador. Descargá un respaldo antes de cerrar; no se enviarán cambios nuevos hasta recuperar el almacenamiento.'; }

export function useCloudSync(options: Options): CloudSyncState {
  const [client] = useState(getCloudClient);
  const [state, setState] = useState<State>(() => emptyState(Boolean(client)));
  const stateRef = useRef(state); stateRef.current = state;
  const optionsRef = useRef(options); optionsRef.current = options;
  const active = useRef<ActiveAccount | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const generation = useRef(0);
  const running = useRef(false);
  const queued = useRef(false);
  const attachingUid = useRef<string | null>(null);
  const activating = useRef(false);
  const mounted = useRef(true);
  const releaseLock = useRef<(() => void) | null>(null);
  const conflictPlan = useRef<{ plan: SyncPlan; remote: SyncRow[] } | null>(null);
  const applied = useRef<{ before: string; after: string; document: SyncDocument } | null>(null);
  const serializedCache = useRef<string | null>(null);
  const syncRef = useRef<() => Promise<void>>(async () => {});

  function patch(next: Partial<State>) { if (mounted.current) setState(previous => ({ ...previous, ...next })); }
  function live(uid: string, epoch: number) { return mounted.current && generation.current === epoch && active.current?.uid === uid && sessionRef.current?.user.id === uid; }
  function currentDocument(): SyncDocument {
    const raw = { data: optionsRef.current.data, preferences: optionsRef.current.preferences };
    const signature = documentSignature(raw);
    if (applied.current) {
      if (signature === applied.current.before) return structuredClone(applied.current.document);
      if (signature === applied.current.after) applied.current = null;
      else applied.current = null;
    }
    return canonicalDocument(raw);
  }
  function publish(document: SyncDocument) {
    const next = canonicalDocument(document);
    const before = documentSignature({ data: optionsRef.current.data, preferences: optionsRef.current.preferences });
    const after = documentSignature(next);
    if (before === after) return;
    applied.current = { before, after, document: next };
    optionsRef.current.onDocument(structuredClone(next));
  }
  function persist(account: ActiveAccount, next: CloudCache) {
    if (!account.writable) throw new Error('Esta cuenta está abierta en otra pestaña.');
    const stored = localStorage.getItem(account.key);
    if (serializedCache.current !== null && stored !== serializedCache.current) {
      // A writer that does not honor our lock must not silently replace either draft.
      try { writeCloudCache(localStorage, `${account.key}:recovery:${crypto.randomUUID()}`, { ...next, document: currentDocument() }); } catch { /* Keep in-memory records for export. */ }
      account.writable = false;
      patch({ readOnly: true, phase: 'error', error: 'La copia de esta cuenta cambió desde otra pestaña. Tus cambios se conservaron para recuperación; descargá un respaldo antes de recargar.' });
      throw new Error('La copia local cambió desde otra pestaña.');
    }
    serializedCache.current = writeCloudCache(localStorage, account.key, next);
    account.cache = next;
  }
  async function acquire(uid: string, epoch = generation.current): Promise<boolean> {
    releaseLock.current?.(); releaseLock.current = null;
    if (!navigator.locks) return false;
    return new Promise<boolean>(resolve => {
      let settled = false;
      void navigator.locks.request(`konten:cloud:${cloudNamespace}:${uid}`, { ifAvailable: true }, async lock => {
        if (!lock || !mounted.current || generation.current !== epoch || sessionRef.current?.user.id !== uid) { settled = true; resolve(false); return; }
        await new Promise<void>(release => { releaseLock.current = release; settled = true; resolve(true); });
      }).catch(() => { if (!settled) resolve(false); });
    });
  }
  function pinnedClient(uid: string): SupabaseClient {
    const session = sessionRef.current;
    if (!cloudConfiguration || session?.user.id !== uid) throw new Error('La sesión cambió.');
    // Pin this request cycle to its original owner even if another tab changes Auth.
    return createClient(cloudConfiguration.url, cloudConfiguration.publishableKey, {
      global: { fetch: cloudFetch, headers: { Authorization: `Bearer ${session.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  function deferred() {
    return optionsRef.current.deferSync || document.activeElement instanceof HTMLElement
      && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  }
  async function attach(session: Session | null) {
    if (session?.user.id && attachingUid.current === session.user.id) {
      sessionRef.current = session;
      return;
    }
    if (session?.user.id && active.current?.uid === session.user.id) {
      sessionRef.current = session;
      patch({ email: session.user.email ?? null });
      return;
    }
    const epoch = ++generation.current;
    attachingUid.current = session?.user.id ?? null;
    const departing = active.current;
    if (departing?.cache && departing.writable) {
      try { persist(departing, { ...departing.cache, document: currentDocument() }); } catch { /* Owner-isolated existing outbox remains available on next login. */ }
    }
    releaseLock.current?.(); releaseLock.current = null;
    const wasCloud = Boolean(active.current);
    active.current = null; sessionRef.current = session; serializedCache.current = null;
    conflictPlan.current = null; applied.current = null;
    if (wasCloud) optionsRef.current.onLocal();
    if (!session) { patch({ ...emptyState(Boolean(client)), phase: 'local' }); attachingUid.current = null; return; }
    patch({ email: session.user.email ?? null, phase: 'loading', isCloud: false, busy: true, error: '', conflicts: [], recovery: false, readOnly: false });
    const uid = session.user.id;
    const key = `konten:cloud:${cloudNamespace}:${uid}:v1`;
    const writable = await acquire(uid, epoch);
    if (!mounted.current || generation.current !== epoch || sessionRef.current?.user.id !== uid) return;
    try {
      const cache = readCloudCache(localStorage, key, uid);
      serializedCache.current = localStorage.getItem(key);
      const account: ActiveAccount = { uid, key, cache, writable };
      active.current = account;
      if (cache) {
        publish(cache.document);
        patch({ isCloud: true, busy: false, migration: null, phase: writable ? 'pending' : 'error', lastSynced: cache.lastSynced,
          readOnly: !writable, pendingCount: cache.pendingOperation?.changes.length ?? 0,
          error: writable ? '' : 'Esta cuenta ya está abierta en otra pestaña. Cerrá la otra pestaña y tocá Sincronizar ahora para editar aquí.' });
        if (writable) queued.current = true;
      } else if (!writable) {
        patch({ busy: false, isCloud: true, readOnly: true, phase: 'error', error: 'Esta cuenta ya está abierta en otra pestaña. Cerrá la otra pestaña y tocá Sincronizar ahora.' });
        publish(materializeSyncRows([]));
      } else {
        const transport = pinnedClient(uid);
        const remote = await fetchCloudRows(transport);
        if (!live(uid, epoch)) return;
        const local = { data: optionsRef.current.data, preferences: optionsRef.current.preferences };
        patch({ busy: false, phase: 'migration', isCloud: false, lastSynced: null,
          migration: { localCount: count(local), remoteCount: remote.filter(row => !row.deleted && ['income', 'expense', 'goal'].includes(row.entity_type)).length, hasLocalData: hasOwnData(local) } });
      }
    } catch (problem) {
      if (generation.current === epoch) patch({ busy: false, phase: 'error', error: cloudError(problem), readOnly: true });
    } finally {
      if (generation.current === epoch) attachingUid.current = null;
    }
  }

  async function syncNow() {
    const account = active.current;
    if (!client || !account || !sessionRef.current) return;
    if (activating.current || attachingUid.current) return;
    if (!account.writable) {
      const epoch = generation.current;
      const writable = await acquire(account.uid, epoch);
      if (!live(account.uid, epoch)) return;
      if (!writable) { patch({ error: 'Cerrá la otra pestaña de esta cuenta y volvé a intentar.', readOnly: true, phase: 'error' }); return; }
      account.writable = true;
      // The other tab may have advanced its durable draft while we only viewed it.
      try {
        account.cache = readCloudCache(localStorage, account.key, account.uid);
        serializedCache.current = localStorage.getItem(account.key);
        if (account.cache) publish(account.cache.document);
        else { const session = sessionRef.current; await attach(null); await attach(session); return; }
        patch({ readOnly: false, error: '' });
      } catch { patch({ phase: 'error', error: storageProblem(), readOnly: true }); return; }
    }
    if (!account.cache) {
      if (stateRef.current.phase === 'migration') return;
      const current = sessionRef.current;
      active.current = null;
      await attach(current);
      return;
    }
    if (running.current) { queued.current = true; return; }
    if (conflictPlan.current) { patch({ phase: 'conflict', conflicts: conflictPlan.current.plan.conflicts, readOnly: true }); return; }
    if (deferred()) { queued.current = true; return; }
    const uid = account.uid, epoch = generation.current;
    running.current = true; queued.current = false;
    patch({ phase: 'syncing', busy: false, error: '' });
    try {
      let cache = { ...account.cache, document: currentDocument() };
      persist(account, cache);
      if (!navigator.onLine) { patch({ phase: 'offline', pendingCount: cache.pendingOperation?.changes.length || 1 }); return; }
      const transport = pinnedClient(uid);
      for (let cycle = 0; cycle < 12; cycle++) {
        if (!live(uid, epoch)) return;
        cache = account.cache!;
        if (cache.pendingOperation) {
          const receipt = await applyCloudChanges(transport, cache.pendingOperation.id, cache.pendingOperation.changes);
          if (!live(uid, epoch)) return;
          cache = { ...account.cache!, document: currentDocument(),
            baseRows: receipt.applied ? mergeAcknowledgedRows(account.cache!.baseRows, receipt.rows) : account.cache!.baseRows,
            pendingOperation: undefined };
          persist(account, cache);
        }
        const remote = await fetchCloudRows(transport);
        if (!live(uid, epoch)) return;
        cache = { ...account.cache!, document: currentDocument() };
        persist(account, cache);
        if (deferred()) { queued.current = true; patch({ phase: 'pending' }); return; }
        const plan = planSync(cache.baseRows, cache.document, remote);
        if (plan.conflicts.length) {
          conflictPlan.current = { plan, remote };
          persist(account, { ...cache, document: plan.document });
          publish(plan.document);
          patch({ phase: 'conflict', conflicts: plan.conflicts, readOnly: true, pendingCount: plan.changes.length + plan.conflicts.length });
          return;
        }
        if (!plan.changes.length) {
          const lastSynced = new Date().toISOString();
          persist(account, { ...cache, document: plan.document, baseRows: remote, lastSynced });
          publish(plan.document);
          patch({ phase: 'synced', pendingCount: 0, conflicts: [], lastSynced, readOnly: false, error: '' });
          return;
        }
        // A batch fits the server limits. The complete document keeps later batches durable.
        const changes = [] as typeof plan.changes;
        for (const change of plan.changes.slice(0, 500)) {
          const candidate = [...changes, change];
          if (new TextEncoder().encode(JSON.stringify(candidate)).length > 1_900_000) break;
          changes.push(change);
        }
        if (!changes.length) throw new Error('Un registro supera el tamaño admitido por sincronización.');
        const pendingOperation = { id: crypto.randomUUID(), changes };
        persist(account, { ...cache, document: plan.document, baseRows: remote, pendingOperation });
        publish(plan.document);
        patch({ pendingCount: plan.changes.length });
      }
      queued.current = true;
      patch({ phase: 'pending' });
    } catch (problem) {
      if (live(uid, epoch)) {
        const storageFailed = problem instanceof DOMException && ['QuotaExceededError', 'SecurityError'].includes(problem.name);
        patch({ phase: navigator.onLine ? 'error' : 'offline', error: storageFailed ? storageProblem() : cloudError(problem), pendingCount: account.cache?.pendingOperation?.changes.length || 1,
          readOnly: storageFailed || !account.writable });
      }
    } finally {
      running.current = false;
    }
  }
  syncRef.current = syncNow;

  async function activate(mode: 'import' | 'cloud') {
    const account = active.current;
    if (!account?.writable || account.cache || !sessionRef.current || activating.current) return;
    const uid = account.uid, epoch = generation.current;
    activating.current = true;
    patch({ busy: true, error: '' });
    try {
      const remote = await fetchCloudRows(pinnedClient(uid));
      if (!live(uid, epoch)) return;
      const source = { data: optionsRef.current.data, preferences: optionsRef.current.preferences };
      if (mode === 'import' && !hasOwnData(source)) throw new Error('Los ejemplos no se incorporan a una cuenta.');
      const plan = mode === 'import' ? planSync([], source, remote) : { document: materializeSyncRows(remote), changes: [], conflicts: [] };
      const cache: CloudCache = { version: 1, owner: uid, document: plan.document, baseRows: mode === 'import' ? [] : remote, lastSynced: null };
      persist(account, cache);
      publish(plan.document);
      patch({ isCloud: true, migration: null, busy: false, phase: plan.conflicts.length ? 'conflict' : 'pending', conflicts: plan.conflicts,
        readOnly: plan.conflicts.length > 0, pendingCount: plan.changes.length + plan.conflicts.length });
      if (plan.conflicts.length) conflictPlan.current = { plan, remote };
      else queued.current = true;
    } catch (problem) { if (live(uid, epoch)) patch({ busy: false, phase: 'error', error: cloudError(problem) }); }
    finally { activating.current = false; }
  }

  function resolveConflict(key: string, choice: 'local' | 'remote') {
    const account = active.current, pending = conflictPlan.current;
    if (!account?.cache || !account.writable || !pending) return;
    try {
      const plan = resolveSyncConflicts(pending.plan, { [key]: choice });
      persist(account, { ...account.cache, document: plan.document, ...(plan.conflicts.length ? {} : { baseRows: pending.remote }) });
      publish(plan.document);
      conflictPlan.current = plan.conflicts.length ? { ...pending, plan } : null;
      patch({ conflicts: plan.conflicts, readOnly: plan.conflicts.length > 0, phase: plan.conflicts.length ? 'conflict' : 'pending', pendingCount: plan.changes.length + plan.conflicts.length });
      if (!plan.conflicts.length) queued.current = true;
    } catch { patch({ phase: 'error', error: storageProblem(), readOnly: true }); }
  }

  async function authAction(action: () => Promise<void>) {
    patch({ busy: true, error: '', feedback: '' });
    try { await action(); }
    catch (problem) { patch({ error: cloudError(problem) }); }
    finally { patch({ busy: false }); }
  }
  async function signIn(email: string, password: string) {
    if (!client) return;
    patch({ phase: 'loading' });
    await authAction(async () => { const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password }); if (error) throw error; await attach(data.session); });
    if (!sessionRef.current) patch({ phase: 'local' });
  }
  async function signUp(email: string, password: string) {
    if (!client) return;
    await authAction(async () => {
      const { data, error } = await client.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: redirectUrl() } });
      if (error) throw error;
      patch({ feedback: data.session ? 'Tu cuenta está lista.' : 'Revisá tu correo y confirmá la cuenta. Después iniciá sesión en cada dispositivo.' });
    });
  }
  async function requestPasswordReset(email: string) {
    if (!client) return;
    await authAction(async () => { const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirectUrl() }); if (error) throw error;
      patch({ feedback: 'Si el correo tiene una cuenta, recibirás un enlace para elegir otra contraseña.' }); });
  }
  async function updatePassword(password: string) {
    if (!client) return;
    await authAction(async () => { const { error } = await client.auth.updateUser({ password }); if (error) throw error; patch({ recovery: false, feedback: 'Tu contraseña se actualizó.' }); });
  }
  async function signOut() {
    if (!client) return;
    const account = active.current;
    if (account?.cache && account.writable) {
      try { persist(account, { ...account.cache, document: currentDocument() }); }
      catch { patch({ phase: 'error', error: storageProblem(), readOnly: true }); return; }
    }
    ++generation.current;
    releaseLock.current?.(); releaseLock.current = null;
    active.current = null; sessionRef.current = null; conflictPlan.current = null; applied.current = null;
    attachingUid.current = null;
    optionsRef.current.onLocal();
    patch({ ...emptyState(Boolean(client)), phase: 'local', busy: true });
    // Local sign-out works offline and leaves this owner's queue isolated for next login.
    try { const { error } = await client.auth.signOut({ scope: 'local' }); if (error) throw error; }
    catch { patch({ error: 'No se pudo cerrar la sesión por completo. Tus datos de cuenta ya se ocultaron; volvé a intentar antes de compartir este navegador.' }); }
    finally { patch({ busy: false }); }
  }

  useEffect(() => {
    mounted.current = true;
    if (!client) return;
    let disposed = false;
    let authChanges = 0;
    const { data: listener } = client.auth.onAuthStateChange((event, session) => {
      authChanges++;
      // Do not await Auth methods from this callback (the SDK owns an internal lock).
      setTimeout(() => { if (disposed || !mounted.current) return; void attach(session).then(() => { if (!disposed && event === 'PASSWORD_RECOVERY') patch({ recovery: true }); }); }, 0);
    });
    void client.auth.getSession().then(({ data, error }) => {
      if (disposed || !mounted.current) return;
      if (authChanges > 0) return;
      if (error) { patch({ phase: 'error', error: cloudError(error) }); return; }
      void attach(data.session);
    });
    const online = () => { queued.current = true; void syncRef.current(); };
    const focus = () => { if (document.visibilityState === 'visible') { queued.current = true; void syncRef.current(); } };
    const timer = setInterval(() => { if (!document.hidden) void syncRef.current(); }, 15_000);
    const drain = setInterval(() => { if (queued.current && !deferred()) void syncRef.current(); }, 1000);
    window.addEventListener('online', online); window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      disposed = true;
      mounted.current = false; ++generation.current;
      listener.subscription.unsubscribe(); clearInterval(timer); clearInterval(drain);
      window.removeEventListener('online', online); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus);
      releaseLock.current?.(); releaseLock.current = null;
    };
  }, [client]);

  useEffect(() => {
    const account = active.current;
    if (!account?.cache || !account.writable || conflictPlan.current) return;
    try {
      const document = currentDocument();
      if (documentSignature(document) === documentSignature(account.cache.document)) return;
      persist(account, { ...account.cache, document });
      patch({ phase: navigator.onLine ? 'pending' : 'offline', pendingCount: account.cache.pendingOperation?.changes.length || 1, error: '' });
      queued.current = true;
    } catch { patch({ phase: 'error', error: storageProblem(), readOnly: true }); }
  }, [options.data, options.preferences]);

  return { ...state, signIn, signUp, requestPasswordReset, updatePassword, signOut, activate, syncNow, resolveConflict };
}
