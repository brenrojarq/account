import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import projectConfig from '../../cloud-config.json';
import { normalizeSyncRows, type SyncChange, type SyncRow } from './syncModel';

export interface CloudConfiguration { url: string; publishableKey: string }

/** A stalled request must not keep an account switch or pending queue stuck. */
export async function cloudFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const cancel = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 15_000);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', cancel); }
}

export function validateCloudConfiguration(url: unknown, key: unknown): CloudConfiguration | null {
  if (typeof url !== 'string' || typeof key !== 'string' || !url || !key) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !/^[a-z\d-]+\.supabase\.co$/i.test(parsed.hostname)
      || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) return null;
    if (!/^sb_publishable_[a-z\d_-]+$/i.test(key)) return null;
    return { url: parsed.origin, publishableKey: key };
  } catch { return null; }
}

export const cloudConfiguration = validateCloudConfiguration(
  import.meta.env.VITE_SUPABASE_URL || projectConfig.url,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || projectConfig.publishableKey,
);
export const cloudNamespace = cloudConfiguration ? new URL(cloudConfiguration.url).hostname : 'unconfigured';
let instance: SupabaseClient | null = null;
export function getCloudClient(): SupabaseClient | null {
  if (!cloudConfiguration || import.meta.env.MODE === 'portable') return null;
  instance ??= createClient(cloudConfiguration.url, cloudConfiguration.publishableKey, {
    global: { fetch: cloudFetch },
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: `konten:auth:${cloudNamespace}` },
  });
  return instance;
}

export function cloudError(problem: unknown): string {
  const message = problem instanceof Error ? problem.message : typeof problem === 'object' && problem && 'message' in problem ? String(problem.message) : '';
  if (/invalid login credentials/i.test(message)) return 'El correo o la contraseña no coinciden.';
  if (/email not confirmed/i.test(message)) return 'Confirmá tu correo antes de iniciar sesión.';
  if (/already registered/i.test(message)) return 'Este correo ya tiene una cuenta. Probá iniciar sesión o recuperar tu contraseña.';
  if (/rate limit|too many requests|429/i.test(message)) return 'Se hicieron muchos intentos. Esperá unos minutos antes de volver a probar.';
  if (/jwt|refresh token|session.*expired/i.test(message)) return 'La sesión necesita renovarse. Volvé a iniciar sesión; tus cambios locales se conservan.';
  if (/schema cache|does not exist|could not find.*function|permission denied/i.test(message)) return 'La base de datos de sincronización todavía necesita terminar su configuración.';
  if (/fetch|network|offline|timeout|abort/i.test(message)) return 'No se pudo conectar con tu cuenta. Tus cambios quedan pendientes en este dispositivo.';
  return 'No se pudo completar la operación con tu cuenta. Tus cambios locales se conservan. Volvé a intentar.';
}

/** The API's default row limit is not a complete account snapshot. Always paginate. */
export async function fetchCloudRows(client: SupabaseClient): Promise<SyncRow[]> {
  const rows: unknown[] = [];
  const size = 500;
  for (let offset = 0; ; offset += size) {
    const { data, error } = await client.from('konten_records')
      .select('entity_type,entity_id,payload,revision,deleted,updated_at')
      .order('entity_type').order('entity_id').range(offset, offset + size - 1);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Respuesta incompleta de sincronización.');
    rows.push(...data);
    if (data.length < size) break;
    if (rows.length > 100_000) throw new Error('La cuenta supera el límite de registros de esta versión.');
  }
  return normalizeSyncRows(rows);
}

export interface ApplyCloudResult { applied: boolean; rows: SyncRow[]; conflicts: SyncRow[] }
export async function applyCloudChanges(client: SupabaseClient, operationId: string, changes: SyncChange[]): Promise<ApplyCloudResult> {
  const { data, error } = await client.rpc('konten_apply_changes', { p_operation_id: operationId, p_changes: changes });
  if (error) throw error;
  if (!data || typeof data.applied !== 'boolean' || !Array.isArray(data.rows) || !Array.isArray(data.conflicts)) throw new Error('Respuesta incompleta de sincronización.');
  return { applied: data.applied, rows: normalizeSyncRows(data.rows), conflicts: normalizeSyncRows(data.conflicts) };
}
