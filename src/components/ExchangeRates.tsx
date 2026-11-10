import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowRight, Check, ChevronDown, ExternalLink, RefreshCw } from 'lucide-react';
import { isValidRateSnapshot, type CurrencyRateSnapshot, type RateType } from '../lib/currency';
import { BAC_SOURCE_URL, fetchBacRates, isRateStale, loadCachedRates, saveCachedRates } from '../lib/exchangeRates';

export interface ManualRateValues { usd: number; eur: number; date: string }

function matchesSaved(snapshot: CurrencyRateSnapshot, saved: CurrencyRateSnapshot | null) {
  return saved !== null && saved.usd === snapshot.usd && saved.eur === snapshot.eur
    && saved.date === snapshot.date && saved.fetchedAt === snapshot.fetchedAt
    && saved.provider === snapshot.provider && saved.rateType === snapshot.rateType;
}

export function useExchangeRates(rateType: RateType) {
  const [snapshots, setSnapshots] = useState<Partial<Record<RateType, CurrencyRateSnapshot | null>>>(() => ({ [rateType]: loadCachedRates(rateType) }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const memory = useRef(snapshots);
  const currentType = useRef(rateType);
  const attempted = useRef(new Set<RateType>());
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  currentType.current = rateType;

  const remember = useCallback((snapshot: CurrencyRateSnapshot) => {
    memory.current = { ...memory.current, [snapshot.rateType]: snapshot };
    setSnapshots(previous => ({ ...previous, [snapshot.rateType]: snapshot }));
    let persisted = false;
    try {
      saveCachedRates(snapshot);
      const saved = loadCachedRates(snapshot.rateType);
      persisted = matchesSaved(snapshot, saved);
    } catch {
      // A quota/privacy failure must not discard rates already held in memory.
    }
    setStorageWarning(!persisted);
  }, []);

  useEffect(() => {
    const restore = () => {
      controller.current?.abort();
      generation.current++;
      const restored = { buy: loadCachedRates('buy'), sell: loadCachedRates('sell') };
      memory.current = restored;
      setSnapshots(restored);
      setLoading(false);
      setError(null);
      setStorageWarning(false);
    };
    window.addEventListener('konten:rates-restored', restore);
    return () => window.removeEventListener('konten:rates-restored', restore);
  }, []);

  const refresh = useCallback(async () => {
    const requestedType = rateType;
    attempted.current.add(requestedType);
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const requestGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const snapshot = await fetchBacRates(requestedType, request.signal);
      if (!mounted.current || request.signal.aborted || generation.current !== requestGeneration || currentType.current !== requestedType) return;
      remember(snapshot);
    } catch (cause) {
      if (!mounted.current || request.signal.aborted || generation.current !== requestGeneration || currentType.current !== requestedType) return;
      setError(cause instanceof Error ? cause.message : 'No se pudo consultar BAC. Puedes ingresar una referencia manual.');
    } finally {
      if (mounted.current && generation.current === requestGeneration && currentType.current === requestedType) setLoading(false);
    }
  }, [rateType, remember]);

  useEffect(() => {
    mounted.current = true;
    setLoading(false);
    setError(null);
    const cached = memory.current[rateType] ?? loadCachedRates(rateType);
    setStorageWarning(cached !== null && !matchesSaved(cached, loadCachedRates(rateType)));
    memory.current = { ...memory.current, [rateType]: cached };
    setSnapshots(previous => ({ ...previous, [rateType]: cached }));
    // Defer until after effect setup: React StrictMode can clean up/replay the
    // effect before any request starts, without making two bank requests.
    const timer = window.setTimeout(() => {
      const current = memory.current[rateType];
      if (import.meta.env.MODE !== 'portable' && !attempted.current.has(rateType) && (!current || (current.provider === 'BAC' && isRateStale(current)))) void refresh();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      mounted.current = false;
      generation.current++;
      controller.current?.abort();
    };
  }, [rateType, refresh]);

  const saveManual = useCallback(({ usd, eur, date }: ManualRateValues) => {
    const snapshot: CurrencyRateSnapshot = { usd, eur, date, provider: 'manual', rateType, dateKind: 'effective', fetchedAt: new Date().toISOString() };
    if (!isValidRateSnapshot(snapshot)) throw new Error('Ingresa ambas tasas como números mayores que cero y una fecha válida.');
    attempted.current.add(rateType);
    controller.current?.abort();
    generation.current++;
    setLoading(false);
    setError(null);
    remember(snapshot);
  }, [rateType, remember]);

  const snapshot = snapshots[rateType] ?? null;
  return { snapshot, loading, error, refresh, saveManual, rateType, stale: snapshot !== null && isRateStale(snapshot), storageWarning };
}

export type ExchangeRatesState = ReturnType<typeof useExchangeRates>;

function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString('es-NI', { day: 'numeric', month: 'short', year: 'numeric' });
}

function todayInManagua() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Managua', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function ExchangeRatesPanel({ state, onRateTypeChange }: { state: ExchangeRatesState; onRateTypeChange?: (rateType: RateType) => void }) {
  const [manualOpen, setManualOpen] = useState(false);
  const [manualError, setManualError] = useState('');
  const [feedback, setFeedback] = useState('');
  const snapshot = state.snapshot;
  const rateLabel = state.rateType === 'sell' ? 'Venta' : 'Compra';
  const rate = (value: number) => new Intl.NumberFormat('es-NI', { minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(value);
  useEffect(() => { setManualError(''); setFeedback(''); setManualOpen(false); }, [state.rateType]);

  function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      state.saveManual({ usd: Number(form.get('usd')), eur: Number(form.get('eur')), date: String(form.get('date')) });
      setManualError('');
      setFeedback('Referencia manual aplicada.');
      setManualOpen(false);
    } catch (cause) {
      setManualError(cause instanceof Error ? cause.message : 'Revisa las tasas y la fecha.');
    }
  }

  return <section className="fx-panel" aria-labelledby="fx-panel-title">
    <div className="fx-heading"><div><h3 id="fx-panel-title">Tipo de cambio</h3><p>Una referencia clara para convertir USD, EUR y córdobas.</p></div><a href={BAC_SOURCE_URL} target="_blank" rel="noreferrer noopener">BAC Nicaragua <ExternalLink size={12} /></a></div>
    <label className="fx-type-label">Referencia de BAC<select value={state.rateType} disabled={!onRateTypeChange} onChange={event => onRateTypeChange?.(event.target.value as RateType)}><option value="sell">Venta</option><option value="buy">Compra</option></select></label>
    <p className="fx-type-description">{state.rateType === 'sell' ? 'Venta: BAC vende dólares o euros. Es la referencia cuando compras divisas.' : 'Compra: BAC compra tus dólares o euros y entrega córdobas.'}</p>
    {snapshot ? <>
      <div className="fx-rate-grid">{[{ code: 'USD', value: snapshot.usd }, { code: 'EUR', value: snapshot.eur }].map(item => <div className="fx-rate" key={item.code}><span>1 {item.code}<ArrowRight size={12} /></span><strong>C$ {rate(item.value)}</strong></div>)}</div>
      <div className="fx-source"><span className={`fx-source-badge ${snapshot.provider === 'manual' ? 'manual' : ''}`}>{snapshot.provider === 'BAC' ? 'Fuente: BAC Nicaragua' : 'Fuente: referencia manual'} · {rateLabel}</span><span>{snapshot.dateKind === 'observed' || (snapshot.provider === 'BAC' && snapshot.dateKind !== 'effective') ? 'Consultada el' : 'Fecha efectiva:'} {formatDate(snapshot.date)}</span></div>
      {snapshot.provider === 'BAC' && snapshot.dateKind !== 'effective' && <p className="fx-date-note">BAC no indica una fecha efectiva verificable en esta respuesta; mostramos la fecha de consulta.</p>}
      {state.stale && <p className="fx-warning"><AlertCircle size={14} /><span>Esta referencia corresponde a otra fecha. Revisa que siga siendo adecuada antes de convertir importes.</span></p>}
    </> : <div className="fx-unavailable"><AlertCircle size={17} /><div><strong>Sin tipo de cambio disponible</strong><p>Las conversiones entre monedas quedan pendientes hasta obtener una referencia válida de BAC o ingresar ambas tasas manualmente.</p></div></div>}
    {state.error && <p className="fx-error" role="status"><AlertCircle size={14} /><span>{state.error}{snapshot ? ' Se conserva la referencia mostrada arriba.' : ''}</span></p>}
    <button type="button" className="outline-button fx-refresh" onClick={() => { setFeedback(''); void state.refresh(); }} disabled={state.loading}><RefreshCw size={14} />{state.loading ? 'Consultando BAC…' : 'Actualizar desde BAC'}</button>
    {snapshot?.provider === 'manual' && <p className="fx-date-note">La referencia manual se conserva hasta que guardes otra o una consulta a BAC tenga éxito.</p>}
    {state.storageWarning && <p className="fx-warning" role="status"><AlertCircle size={14} /><span>La referencia está aplicada, pero no pudo guardarse en este navegador. Tendrás que ingresarla de nuevo al cerrar o recargar la página.</span></p>}
    {feedback && <p className="fx-feedback" role="status"><Check size={14} />{feedback}</p>}
    <button type="button" className="fx-manual-toggle" aria-expanded={manualOpen} aria-controls="fx-manual-form" onClick={() => { setManualOpen(!manualOpen); setManualError(''); }}>{manualOpen ? 'Cerrar ingreso manual' : 'Ingresar tasas manualmente'}<ChevronDown size={14} className={manualOpen ? 'open' : ''} /></button>
    {manualOpen && <form id="fx-manual-form" className="fx-manual-form" onSubmit={submitManual} key={state.rateType}><p>Ingresa la pareja completa en córdobas. Se guardará como referencia manual de <strong>{rateLabel.toLowerCase()}</strong>, sin atribuirla a BAC.</p><div className="fx-form-grid"><label>Córdobas por 1 USD<input name="usd" type="number" min="0" step="any" defaultValue={snapshot?.usd ?? ''} placeholder="Tasa USD" required /></label><label>Córdobas por 1 EUR<input name="eur" type="number" min="0" step="any" defaultValue={snapshot?.eur ?? ''} placeholder="Tasa EUR" required /></label></div><label>Fecha efectiva<input name="date" type="date" defaultValue={snapshot?.date ?? todayInManagua()} required /></label>{manualError && <p className="fx-error" role="alert">{manualError}</p>}<button type="submit" className="primary-button">Aplicar referencia manual <Check size={14} /></button></form>}
  </section>;
}
