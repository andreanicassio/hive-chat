import { api } from './api.js';

/**
 * Iscrizione alle notifiche push.
 *
 * Su iPhone funzionano solo se l'app è stata aggiunta alla schermata Home:
 * in Safari normale l'API c'è ma il permesso non si può nemmeno chiedere.
 * Per questo `pushState()` distingue «non supportate» da «serve installarla»:
 * sono due messaggi diversi da dare a chi guarda.
 */

export type PushState =
  | 'unsupported' // il browser non ha le push
  | 'needs-install' // iOS: va aggiunta alla schermata Home
  | 'unconfigured' // il server non ha le chiavi VAPID
  | 'denied' // permesso negato dall'utente
  | 'off' // supportate, permesso non ancora chiesto
  | 'on'; // iscritte

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari su iOS non implementa `display-mode`, usa questa proprietà sua.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  const { publicKey } = await api.pushKey().catch(() => ({ publicKey: null }));
  if (!publicKey) return 'unconfigured';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

/**
 * La chiave VAPID viaggia in base64url, il browser la vuole in byte.
 *
 * Il buffer si costruisce esplicitamente perché `applicationServerKey` vuole
 * un `ArrayBuffer` vero, non uno che potrebbe essere condiviso.
 */
function decodeKey(base64: string): ArrayBuffer {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

/**
 * Chiede il permesso e registra questo dispositivo.
 *
 * Restituisce lo stato finale, così chi chiama non deve reinterrogare: se
 * l'utente ha detto no, la risposta è `denied` e non si insiste — riproporre
 * un permesso negato non lo fa cambiare idea, lo fa solo arrabbiare.
 */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  const { publicKey } = await api.pushKey();
  if (!publicKey) return 'unconfigured';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';

  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeKey(publicKey),
    }));

  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return 'off';
  await api.pushSubscribe({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  return 'on';
}

/** Toglie questo dispositivo: gli altri restano iscritti. */
export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return 'off';
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
  return 'off';
}
