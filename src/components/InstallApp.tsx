import { useCallback, useEffect, useState } from 'react';
import { Check, Download, RefreshCw, Share, Smartphone, WifiOff, X } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import kontenLogo from '../assets/konten-logo.png';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

type InstallOutcome = 'idle' | 'accepted' | 'dismissed' | 'failed';

function standalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function useInstallApp() {
  const [isInstalled, setIsInstalled] = useState(standalone);
  const [deferredPrompt, setDeferredPrompt] = useState<InstallPromptEvent | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installOutcome, setInstallOutcome] = useState<InstallOutcome>('idle');
  const [registrationFailed, setRegistrationFailed] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateFailed, setUpdateFailed] = useState(false);
  const [{ isIOS, isEmbedded }] = useState(() => ({
    isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    isEmbedded: /FBAN|FBAV|Instagram|Line\/|MicroMessenger|TikTok|GSA\/|; wv\)/i.test(navigator.userAgent),
  }));
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisterError() { setRegistrationFailed(true); },
  });

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    let active = true;
    void navigator.serviceWorker.ready.then(registration => {
      const expectedScript = new URL('./sw.js', location.href).href;
      if (active && registration.active?.scriptURL === expectedScript) {
        setOfflineReady(true);
        setRegistrationFailed(false);
      }
    });
    return () => { active = false; };
  }, [setOfflineReady]);

  useEffect(() => {
    const displayMode = window.matchMedia('(display-mode: standalone)');
    const capturePrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as InstallPromptEvent);
      setInstallOutcome('idle');
    };
    const installed = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
      setInstallOutcome('accepted');
    };
    const displayModeChanged = () => setIsInstalled(standalone());
    window.addEventListener('beforeinstallprompt', capturePrompt);
    window.addEventListener('appinstalled', installed);
    if (displayMode.addEventListener) displayMode.addEventListener('change', displayModeChanged);
    else displayMode.addListener(displayModeChanged);
    return () => {
      window.removeEventListener('beforeinstallprompt', capturePrompt);
      window.removeEventListener('appinstalled', installed);
      if (displayMode.removeEventListener) displayMode.removeEventListener('change', displayModeChanged);
      else displayMode.removeListener(displayModeChanged);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt || isInstalling || isInstalled) return;
    const prompt = deferredPrompt;
    setDeferredPrompt(null);
    setIsInstalling(true);
    try {
      // The browser only receives this request after an explicit button click.
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      setInstallOutcome(outcome);
      // Accepted means the request was accepted. Only appinstalled or display
      // mode establishes installation; a dismissed prompt cannot be reused.
    } catch {
      setInstallOutcome('failed');
    } finally {
      setIsInstalling(false);
    }
  }, [deferredPrompt, isInstalling, isInstalled]);

  const update = useCallback(async () => {
    if (isUpdating) return;
    setIsUpdating(true);
    setUpdateFailed(false);
    try {
      await updateServiceWorker(true);
    } catch {
      setUpdateFailed(true);
    } finally {
      setIsUpdating(false);
    }
  }, [isUpdating, updateServiceWorker]);

  return {
    isInstalled,
    isIOS,
    isEmbedded,
    canInstall: Boolean(deferredPrompt) && !isInstalled && !isInstalling,
    isInstalling,
    installOutcome,
    offlineReady,
    registrationFailed,
    needRefresh,
    isUpdating,
    updateFailed,
    install,
    update,
    dismissUpdate: () => setNeedRefresh(false),
  };
}

export type InstallAppState = ReturnType<typeof useInstallApp>;

export function InstallAppPanel({ state }: { state: InstallAppState }) {
  const showGuide = !state.isInstalled && !state.canInstall && !state.isInstalling;
  return <section className="pwa-install" aria-labelledby="pwa-install-title">
    <div className="pwa-install-heading">
      <img src={kontenLogo} width="44" height="44" alt="" />
      <div><h3 id="pwa-install-title">{state.isInstalled ? 'KONTEN instalada' : 'KONTEN, más cerca de ti'}</h3><p>{state.isInstalled ? 'Tu espacio financiero también está en tus aplicaciones.' : 'Añádela a tu pantalla de inicio y abre tus finanzas con un toque.'}</p></div>
      {state.isInstalled && <Check size={19} aria-hidden="true" />}
    </div>
    {(state.canInstall || state.isInstalling) && <button className="primary-button pwa-install-button" disabled={state.isInstalling} onClick={() => void state.install()}><Download size={16} />{state.isInstalling ? 'Esperando al navegador…' : 'Instalar KONTEN'}</button>}
    {!state.isInstalled && state.installOutcome === 'accepted' && <p className="pwa-install-feedback" role="status">El navegador aceptó la solicitud. Cuando termine, busca KONTEN entre tus aplicaciones.</p>}
    {!state.isInstalled && state.installOutcome === 'dismissed' && <p className="pwa-install-feedback" role="status">Cancelaste la solicitud. Puedes instalarla más tarde desde el menú del navegador.</p>}
    {!state.isInstalled && state.installOutcome === 'failed' && <p className="pwa-install-feedback" role="status">No se pudo abrir la instalación. Usa las opciones del navegador que se indican abajo.</p>}
    {showGuide && <div className="pwa-install-guide">
      {state.isEmbedded ? <><h4><Smartphone size={15} />Abre KONTEN en tu navegador</h4><p>Los navegadores dentro de otras apps pueden impedir la instalación. Abre este enlace en Chrome para Android o Safari para iPhone y iPad.</p><p>Después, usa el menú del navegador para instalarla o añadirla a la pantalla de inicio.</p></> : state.isIOS ? <><h4><Share size={15} />En iPhone o iPad</h4><ol><li>Abre KONTEN en <strong>Safari</strong>.</li><li>Toca <strong>Compartir</strong> en el navegador.</li><li>Elige <strong>Añadir a pantalla de inicio</strong> y confirma con <strong>Añadir</strong>.</li></ol></> : <><h4><Smartphone size={15} />También puedes usar el menú</h4><p>En Chrome para Android, abre el menú ⋮ y busca <strong>Instalar aplicación</strong> o <strong>Añadir a pantalla de inicio</strong>.</p><p>En una computadora, busca la opción de instalación en Chrome o Edge. En iPhone y iPad, abre el enlace en Safari y usa <strong>Compartir → Añadir a pantalla de inicio</strong>.</p><p>Si tu navegador no ofrece estas opciones, puedes seguir usando KONTEN en esta página.</p></>}
    </div>}
    {state.offlineReady && <p className="pwa-offline-ready" role="status"><WifiOff size={15} /><span>KONTEN está lista para abrirse sin conexión en este navegador. Tus registros siguen guardados en este dispositivo.</span></p>}
    {state.registrationFailed && !state.offlineReady && <p className="pwa-install-feedback" role="status">No se pudo preparar el acceso sin conexión. Puedes seguir usando KONTEN con internet e intentar de nuevo más tarde.</p>}
  </section>;
}

export function PwaUpdateNotice({ state }: { state: InstallAppState }) {
  if (!state.needRefresh) return null;
  return <section className="pwa-update" aria-label="Actualización de KONTEN disponible">
    <span className="pwa-update-icon"><RefreshCw size={20} aria-hidden="true" /></span>
    <div className="pwa-update-copy"><h2>Hay una nueva versión de KONTEN</h2><p>Guarda cualquier formulario abierto antes de actualizar. Tus registros guardados se conservan.</p>{state.updateFailed && <p className="pwa-update-error" role="alert">No se pudo actualizar. Comprueba tu conexión y vuelve a intentarlo.</p>}</div>
    <div className="pwa-update-actions"><button className="primary-button" disabled={state.isUpdating} onClick={() => void state.update()}>{state.isUpdating ? 'Actualizando…' : 'Actualizar KONTEN'}</button><button className="pwa-update-later" onClick={state.dismissUpdate} disabled={state.isUpdating}><X size={14} />Más tarde</button></div>
  </section>;
}
