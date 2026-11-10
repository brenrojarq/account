import { useEffect, useId, useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, Cloud, CloudOff, KeyRound, LogIn, LogOut, Mail, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import type { CloudSyncState } from '../hooks/useCloudSync';
import './cloud-account.css';

type AccountMode = 'signin' | 'signup' | 'reset';
type Conflict = CloudSyncState['conflicts'][number];
type ConflictRow = NonNullable<Conflict['local']>;

const entityNames: Record<string, string> = {
  income: 'Ingreso', expense: 'Egreso', goal: 'Meta de ahorro',
  budget: 'Reserva de ahorro', preferences: 'Preferencias',
};

function recordPayload(row: ConflictRow | null) {
  return row?.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown> : null;
}

function conflictName(conflict: Conflict) {
  const payload = recordPayload(conflict.local) ?? recordPayload(conflict.remote);
  return typeof payload?.name === 'string' ? payload.name : entityNames[(conflict.local ?? conflict.remote)?.entity_type ?? ''] ?? 'Registro';
}

function amountLabel(amount: unknown, currency: unknown) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const code = typeof currency === 'string' && currency ? ` ${currency}` : '';
  return `${new Intl.NumberFormat('es-NI', { maximumFractionDigits: 8 }).format(amount)}${code}`;
}

function lastSyncLabel(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleString('es-NI', {
    timeZone: 'America/Managua', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function phaseLabel(state: CloudSyncState) {
  if (state.phase === 'synced') return 'Sincronizado con tu cuenta';
  if (state.phase === 'syncing') return 'Sincronizando cambios…';
  if (state.phase === 'offline') return 'Sin conexión';
  if (state.phase === 'conflict') return 'Hay cambios que necesitan tu revisión';
  if (state.phase === 'error') return 'No se pudo completar la sincronización';
  if (state.phase === 'migration') return 'Elegí con qué datos continuar';
  if (state.phase === 'loading') return 'Preparando tu cuenta…';
  if (state.phase === 'pending') return state.pendingCount === 1 ? '1 cambio pendiente' : `${state.pendingCount} cambios pendientes`;
  return state.isCloud ? 'Tu cuenta está conectada' : 'Guardado en este dispositivo';
}

function VersionDetails({ row }: { row: ConflictRow | null }) {
  if (!row || row.deleted) return <p className="cloud-version-deleted">{row?.deleted ? 'Registro eliminado' : 'Este registro no existe aquí'}</p>;
  const payload = recordPayload(row);
  if (!payload) return <p>Registro pendiente de revisar.</p>;
  const currency = payload.currency ?? payload.savingsCurrency ?? payload.legacyCurrency;
  if (row.entity_type === 'preferences') {
    const charts: Record<string, string> = { pie: 'Pastel', bar: 'Barras', scatter: 'Puntos' };
    const cards: Record<string, string> = { income: 'Ingresos', fixed: 'Gastos fijos', savings: 'Ahorro', available: 'Disponible' };
    return <dl className="cloud-version-details">
      <div><dt>Moneda del resumen</dt><dd>{typeof payload.currency === 'string' ? payload.currency : 'Predeterminada'}</dd></div>
      <div><dt>Gráfica</dt><dd>{typeof payload.chart === 'string' ? charts[payload.chart] ?? payload.chart : 'Predeterminada'}</dd></div>
      <div><dt>Referencia de cambio</dt><dd>{payload.rateType === 'buy' ? 'Compra' : 'Venta'}</dd></div>
      {Array.isArray(payload.cards) && <div><dt>Tarjetas, en orden</dt><dd>{payload.cards.filter((card): card is string => typeof card === 'string').map(card => cards[card] ?? card).join(' · ') || 'Ninguna'}</dd></div>}
      <div><dt>Movimientos recientes</dt><dd>{payload.showTransactions === false ? 'Ocultos' : 'Visibles'}</dd></div>
      <div><dt>Metas en el resumen</dt><dd>{payload.showGoals === false ? 'Ocultas' : 'Visibles'}</dd></div>
    </dl>;
  }
  const rawRate = payload.exchangeRate ?? payload.savingsExchangeRate;
  const rate = rawRate && typeof rawRate === 'object' && !Array.isArray(rawRate) ? rawRate as Record<string, unknown> : null;
  const values = row.entity_type === 'goal'
    ? [['Objetivo', payload.target], ['Ahorrado', payload.saved], ['Aporte mensual', payload.monthly]]
    : [[row.entity_type === 'budget' ? 'Ahorro reservado' : 'Importe original', row.entity_type === 'budget' ? payload.savingsAmount : payload.amount]];
  return <>
    {typeof payload.name === 'string' && <p className="cloud-version-name">{payload.name}</p>}
    <dl className="cloud-version-details">{values.map(([label, value]) => {
      const formatted = amountLabel(value, currency);
      return formatted ? <div key={String(label)}><dt>{String(label)}</dt><dd>{formatted}</dd></div> : null;
    })}
      {typeof payload.category === 'string' && <div><dt>Categoría</dt><dd>{payload.category}</dd></div>}
      {(payload.kind === 'fixed' || payload.kind === 'variable') && <div><dt>Tipo de egreso</dt><dd>{payload.kind === 'fixed' ? 'Fijo' : 'Variable'}</dd></div>}
      {typeof payload.frequency === 'string' && <div><dt>Periodicidad</dt><dd>{payload.frequency === 'biweekly' ? 'Quincenal' : payload.frequency === 'monthly' ? 'Mensual' : 'Puntual'}</dd></div>}
      {typeof payload.date === 'string' && <div><dt>Fecha</dt><dd>{payload.date}</dd></div>}
      {rate && <div><dt>Referencia de cambio guardada</dt><dd>{rate.provider === 'BAC' ? 'BAC' : 'Manual'} · {rate.rateType === 'buy' ? 'compra' : 'venta'}{typeof rate.date === 'string' ? ` · ${rate.date}` : ''}<br />{amountLabel(rate.usd, 'NIO')} por USD · {amountLabel(rate.eur, 'NIO')} por EUR</dd></div>}
      {row.entity_type === 'budget' && typeof payload.legacyCurrencyReview === 'string' && <div><dt>Moneda pendiente de confirmar</dt><dd>{payload.legacyCurrencyReview}</dd></div>}
    </dl>
  </>;
}

export function CloudAccountPanel({ state }: { state: CloudSyncState }) {
  const titleId = useId();
  const [mode, setMode] = useState<AccountMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [localError, setLocalError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const busy = state.busy || submitting;
  const lastSync = lastSyncLabel(state.lastSynced);

  useEffect(() => { if (state.email) { setPassword(''); setConfirmation(''); } }, [state.email]);
  useEffect(() => { setLocalError(''); setPassword(''); setConfirmation(''); }, [mode, state.recovery]);

  async function run(action: () => void | Promise<void>) {
    if (busy) return;
    setLocalError('');
    setSubmitting(true);
    try { await action(); }
    catch (problem) { setLocalError(problem instanceof Error ? problem.message : 'No se pudo completar la acción. Intentá de nuevo.'); }
    finally { setSubmitting(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.recovery) {
      if (password !== confirmation) { setLocalError('Las contraseñas no coinciden.'); return; }
      void run(() => state.updatePassword(password));
    } else if (mode === 'reset') void run(() => state.requestPasswordReset(email.trim()));
    else if (mode === 'signup') void run(() => state.signUp(email.trim(), password));
    else void run(() => state.signIn(email.trim(), password));
  }

  return <section className="cloud-panel" aria-labelledby={titleId}>
    <div className="cloud-heading"><span className="cloud-heading-icon"><Cloud size={22} aria-hidden="true" /></span><div><h3 id={titleId}>Tu cuenta y sincronización</h3><p>Entrá con la misma cuenta para ver tus finanzas en el celular y la computadora.</p></div></div>
    {!state.configured ? <div className="cloud-unavailable"><CloudOff size={20} aria-hidden="true" /><div><strong>Conexión a la nube pendiente</strong><p>La sincronización todavía no está disponible. Podés seguir usando KONTEN y descargar un respaldo de los datos de este navegador.</p></div></div> : <>
      {state.email && <div className="cloud-identity"><UserRound size={19} aria-hidden="true" /><span><strong>Tu cuenta privada</strong><span>{state.email}</span></span></div>}
      {state.recovery ? <form className="cloud-auth-form" onSubmit={submit}>
        <h4>Elegí una nueva contraseña</h4>
        <label>Nueva contraseña<input type="password" name="new-password" autoComplete="new-password" minLength={8} value={password} onChange={event => setPassword(event.target.value)} required disabled={busy} /></label>
        <label>Confirmar nueva contraseña<input type="password" name="confirm-password" autoComplete="new-password" minLength={8} value={confirmation} onChange={event => setConfirmation(event.target.value)} required disabled={busy} /></label>
        <p className="cloud-form-help">Usá al menos 8 caracteres.</p>
        <button type="submit" className="primary-button" disabled={busy}><KeyRound size={15} aria-hidden="true" />{busy ? 'Actualizando…' : 'Guardar nueva contraseña'}</button>
      </form> : !state.email ? <>
        <div className="cloud-auth-tabs" role="group" aria-label="Acceso a tu cuenta">
          <button type="button" className={mode === 'signin' ? 'active' : ''} aria-pressed={mode === 'signin'} onClick={() => setMode('signin')} disabled={busy}>Iniciar sesión</button>
          <button type="button" className={mode === 'signup' ? 'active' : ''} aria-pressed={mode === 'signup'} onClick={() => setMode('signup')} disabled={busy}>Crear cuenta</button>
        </div>
        <form className="cloud-auth-form" onSubmit={submit}>
          {mode === 'reset' && <h4>Recuperar acceso</h4>}
          <label>Correo electrónico<input type="email" name="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} required disabled={busy} /></label>
          {mode !== 'reset' && <label>Contraseña<input type="password" name="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={mode === 'signup' ? 8 : undefined} value={password} onChange={event => setPassword(event.target.value)} required disabled={busy} /></label>}
          {mode === 'signup' && <p className="cloud-form-help">Usá al menos 8 caracteres. Revisá tu correo para confirmar la cuenta antes de iniciar sesión.</p>}
          {mode === 'reset' && <p className="cloud-form-help">Te enviaremos un enlace para que puedas elegir una nueva contraseña.</p>}
          <button type="submit" className="primary-button" disabled={busy}>{mode === 'reset' ? <Mail size={15} aria-hidden="true" /> : <LogIn size={15} aria-hidden="true" />}{busy ? 'Un momento…' : mode === 'signup' ? 'Crear mi cuenta' : mode === 'reset' ? 'Enviar enlace de recuperación' : 'Entrar a mi cuenta'}</button>
          <button type="button" className="text-button cloud-recovery-link" disabled={busy} onClick={() => setMode(mode === 'reset' ? 'signin' : 'reset')}>{mode === 'reset' ? 'Volver a iniciar sesión' : 'Olvidé mi contraseña'}</button>
        </form>
        <p className="cloud-privacy"><ShieldCheck size={16} aria-hidden="true" /><span>Los datos de tu cuenta son privados. Al iniciar sesión podrás elegir cómo incorporar los registros que ya tenés en este dispositivo.</span></p>
      </> : state.migration ? <div className="cloud-migration">
        <h4>Elegí con qué datos continuar</h4>
        <p>Tu cuenta y este navegador pueden tener registros diferentes. La copia local de este dispositivo se conserva.</p>
        <dl className="cloud-migration-counts"><div><dt>En este dispositivo</dt><dd>{state.migration.localCount} registros</dd></div><div><dt>En tu cuenta</dt><dd>{state.migration.remoteCount} registros</dd></div></dl>
        <button className="primary-button" type="button" onClick={() => void run(() => state.activate('cloud'))} disabled={busy}>Usar datos de mi cuenta</button>
        <button className="outline-button" type="button" onClick={() => void run(() => state.activate('import'))} disabled={busy || !state.migration.hasLocalData}>Incorporar registros de este dispositivo</button>
        <p className="cloud-form-help">Los datos de ejemplo no se incorporan. Si un registro fue cambiado en ambos lugares, podrás revisar las dos versiones antes de elegir.</p>
      </div> : <div className="cloud-status-block">
        <div className={`cloud-status cloud-status-${state.phase}`} role="status">{state.phase === 'synced' ? <CheckCircle2 size={18} aria-hidden="true" /> : state.phase === 'offline' ? <CloudOff size={18} aria-hidden="true" /> : <RefreshCw size={18} aria-hidden="true" className={state.phase === 'syncing' || state.phase === 'loading' ? 'cloud-spinning' : ''} />}<strong>{phaseLabel(state)}</strong></div>
        {lastSync && <p className="cloud-last-sync">Última sincronización: {lastSync}</p>}
        {state.phase === 'offline' && <p className="cloud-form-help">Los cambios pendientes se sincronizarán cuando vuelva la conexión y tengas KONTEN abierto.</p>}
        {state.phase === 'pending' && <p className="cloud-form-help">Los cambios aún están pendientes de confirmación en la nube.</p>}
        {state.isCloud && <button className="outline-button" type="button" onClick={() => void run(() => state.syncNow())} disabled={busy || state.phase === 'syncing' || state.phase === 'loading'}><RefreshCw size={15} aria-hidden="true" />Sincronizar ahora</button>}
      </div>}
      {state.conflicts.length > 0 && <div className="cloud-conflicts" aria-label="Cambios por revisar">
        <h4>Revisá las versiones antes de continuar</h4>
        <p>Este registro se modificó en ambos dispositivos. Elegí la versión que querés conservar para cada caso.</p>
        {state.conflicts.map(conflict => <article className="cloud-conflict" key={conflict.key}>
          <h5>{conflictName(conflict)}</h5>
          <div className="cloud-conflict-versions">
            <div className="cloud-version"><h6>Este dispositivo</h6><VersionDetails row={conflict.local} /><button className="outline-button" type="button" onClick={() => void run(() => state.resolveConflict(conflict.key, 'local'))} disabled={busy}>Conservar este dispositivo</button></div>
            <div className="cloud-version"><h6>Tu cuenta en la nube</h6><VersionDetails row={conflict.remote} /><button className="outline-button" type="button" onClick={() => void run(() => state.resolveConflict(conflict.key, 'remote'))} disabled={busy}>Conservar versión de la nube</button></div>
          </div>
        </article>)}
      </div>}
      {state.email && !state.recovery && <button type="button" className="text-button cloud-signout" onClick={() => void run(() => state.signOut())} disabled={busy}><LogOut size={15} aria-hidden="true" />Cerrar sesión</button>}
    </>}
    {(localError || state.error) && <p className="cloud-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{localError || state.error}</span></p>}
    {state.feedback && <p className="cloud-feedback" role="status"><CheckCircle2 size={16} aria-hidden="true" /><span>{state.feedback}</span></p>}
  </section>;
}

export function CloudSyncNotice({ state, onOpen }: { state: CloudSyncState; onOpen: () => void }) {
  if (!state.configured || !state.email || !['migration', 'conflict', 'error', 'offline', 'pending'].includes(state.phase)) return null;
  return <div className={`cloud-notice cloud-notice-${state.phase}`} role="status">
    {state.phase === 'offline' ? <CloudOff size={19} aria-hidden="true" /> : state.phase === 'conflict' || state.phase === 'error' ? <AlertCircle size={19} aria-hidden="true" /> : <Cloud size={19} aria-hidden="true" />}
    <span>{phaseLabel(state)}.{state.phase === 'offline' ? ' Abrí KONTEN con conexión para enviar los cambios pendientes.' : state.phase === 'migration' ? ' Continuá en tu cuenta para compartir tus registros entre dispositivos.' : state.phase === 'conflict' ? ' Elegí qué versión conservar en cada registro.' : ''}</span>
    <button type="button" className="text-button" onClick={onOpen}>Abrir cuenta</button>
  </div>;
}
