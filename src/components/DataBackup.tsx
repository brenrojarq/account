import { useId, useState, type ChangeEvent } from 'react';
import { AlertTriangle, Download, FileJson, Upload } from 'lucide-react';
import {
  BACKUP_MAX_BYTES, createBackup, parseBackup, readBackupRates, restoreBackup, serializeBackup,
  type BackupFinanceData, type KontenBackup,
} from '../lib/backup';

interface DataBackupPanelProps {
  data: BackupFinanceData;
  preferences: unknown;
}

/** Complete local transfer; no account, server, or automatic synchronization. */
export function DataBackupPanel({ data, preferences }: DataBackupPanelProps) {
  const fileId = useId();
  const [pending, setPending] = useState<{ filename: string; backup: KontenBackup } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');

  function downloadCurrent() {
    setError('');
    setFeedback('');
    try {
      // An unavailable cache must not prevent rescuing the records held in memory.
      let rates: KontenBackup['rates'];
      try { rates = readBackupRates(window.localStorage); } catch { /* Storage may be disabled. */ }
      const backup = createBackup(data, preferences, rates);
      const json = serializeBackup(backup);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      if (blob.size > BACKUP_MAX_BYTES) throw new Error('Tus datos superan el límite de 10 MB de un respaldo.');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `konten-respaldo-${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Managua' }).format(new Date(backup.exportedAt))}.json`;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      setFeedback('Se inició la descarga del respaldo completo. Guardá ese archivo antes de reemplazar los datos.');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'No se pudo crear el respaldo. Tus datos siguen en este navegador.');
    }
  }

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    setPending(null);
    setConfirmed(false);
    setError('');
    setFeedback('');
    if (!file) return;
    setReading(true);
    try {
      if (!/\.json$/i.test(file.name)) throw new Error('Elegí un archivo de respaldo con extensión .json.');
      if (file.size > BACKUP_MAX_BYTES) throw new Error('El respaldo supera el límite de 10 MB.');
      const backup = parseBackup(await file.text());
      setPending({ filename: file.name, backup });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'No se pudo leer el respaldo. No se modificó ningún dato.');
    } finally {
      setReading(false);
    }
  }

  function restoreSelected() {
    if (!pending || !confirmed || restoring) return;
    setError('');
    setFeedback('');
    setRestoring(true);
    try {
      restoreBackup(pending.backup, window.localStorage);
    } catch (problem) {
      setRestoring(false);
      setError(problem instanceof Error ? problem.message : 'No se pudo restaurar el respaldo.');
      return;
    }
    window.location.reload();
  }

  const preview = pending?.backup;
  const currencies = preview ? [...new Set([
    ...preview.data.incomes.map(item => item.currency ?? preview.data.legacyCurrency ?? preview.data.legacyCurrencyReview ?? 'Por confirmar'),
    ...preview.data.expenses.map(item => item.currency ?? preview.data.legacyCurrency ?? preview.data.legacyCurrencyReview ?? 'Por confirmar'),
    ...preview.data.goals.map(item => item.currency ?? preview.data.legacyCurrency ?? preview.data.legacyCurrencyReview ?? 'Por confirmar'),
    preview.data.savingsCurrency ?? preview.data.legacyCurrency ?? preview.data.legacyCurrencyReview ?? 'Por confirmar',
  ])] : [];

  return <section className="backup-panel" aria-label="Respaldo y traslado de datos">
    <div className="backup-heading"><FileJson size={23} aria-hidden="true" /><div>
      <h3>Respaldo y traslado de datos</h3>
      <p>Tus registros se guardan en este navegador. Descargá un respaldo en el celular y restauralo en la computadora, o al revés. El traslado es manual; los dispositivos no se sincronizan automáticamente.</p>
    </div></div>
    <p className="backup-privacy">El archivo contiene tus datos financieros, monedas originales, tipos de cambio guardados, metas y preferencias. Guardalo en un lugar privado y trasladalo sólo a dispositivos que controlás.</p>
    <div className="backup-actions">
      <button className="outline-button backup-download" type="button" onClick={downloadCurrent} disabled={restoring}><Download size={15} aria-hidden="true" />Descargar respaldo completo</button>
      <label className={`backup-file-label${reading || restoring ? ' backup-disabled' : ''}`} htmlFor={fileId}><Upload size={15} aria-hidden="true" />{reading ? 'Revisando archivo…' : 'Elegir respaldo para restaurar'}</label>
      <input className="backup-file-input" id={fileId} aria-label="Elegir respaldo para restaurar" type="file" accept=".json,application/json" onChange={selectFile} disabled={reading || restoring} />
    </div>
    {preview && <div className="backup-preview" aria-label="Vista previa del respaldo">
      <h4>Vista previa del respaldo</h4>
      <p className="backup-filename">{pending.filename}</p>
      <p>Creado el {new Date(preview.exportedAt).toLocaleString('es-NI', { timeZone: 'America/Managua' })} · Resumen en {preview.preferences.currency ?? 'la moneda predeterminada'}</p>
      <dl className="backup-counts">
        <div><dt>Ingresos</dt><dd>{preview.data.incomes.length}</dd></div>
        <div><dt>Egresos</dt><dd>{preview.data.expenses.length}</dd></div>
        <div><dt>Metas de ahorro</dt><dd>{preview.data.goals.length}</dd></div>
      </dl>
      <p>Monedas de los registros: {currencies.join(', ')}. Ahorro reservado: {preview.data.savingsAmount.toLocaleString('es-NI', { maximumFractionDigits: 2 })} {preview.data.savingsCurrency ?? preview.data.legacyCurrency ?? preview.data.legacyCurrencyReview ?? '(moneda por confirmar)'}.</p>
      {preview.data.legacyCurrencyReview && <p>La moneda original de registros anteriores sigue pendiente de confirmación en Ajustes ({preview.data.legacyCurrencyReview}).</p>}
      <div className="backup-replace-warning"><AlertTriangle size={17} aria-hidden="true" /><p>Restaurar reemplaza todos los ingresos, egresos, metas, ahorro y preferencias de este navegador. No combina registros. Descargá primero tus datos actuales si querés conservarlos.</p></div>
      <button className="text-button backup-save-current" type="button" onClick={downloadCurrent} disabled={restoring}><Download size={14} aria-hidden="true" />Descargar mis datos actuales antes de reemplazarlos</button>
      <label className="backup-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={restoring} /><span>Confirmo que quiero reemplazar los datos de este navegador con este respaldo.</span></label>
      <div className="backup-restore-actions">
        <button className="primary-button" type="button" onClick={restoreSelected} disabled={!confirmed || restoring}>{restoring ? 'Restaurando…' : 'Restaurar este respaldo'}</button>
        <button className="text-button" type="button" onClick={() => { setPending(null); setConfirmed(false); }} disabled={restoring}>Cancelar</button>
      </div>
    </div>}
    {error && <p className="backup-error" role="alert">{error}</p>}
    {feedback && <p className="backup-feedback" role="status">{feedback}</p>}
  </section>;
}
