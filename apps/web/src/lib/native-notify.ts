/**
 * Notifiche di sistema dentro l'app Mac.
 *
 * Nell'app Mac le push non esistono, e non è una svista né una versione da
 * aggiornare: il motore web che Tauri incorpora (WKWebView) non implementa
 * `PushManager`. Non c'è proprio.
 *
 * Ma le push, lì, non servirebbero comunque a molto: servono a svegliare
 * un'app chiusa, e finché l'app è aperta il filo col server c'è già — il
 * WebSocket. Quindi la notifica non va «consegnata», va solo mostrata, e a
 * mostrarla è il guscio con l'API di macOS.
 *
 * Il ponte è `window.Notification`: dentro l'app non è quella del browser (che
 * non esiste) ma quella che inietta il plugin di Tauri, con la stessa forma.
 * Se manca, il guscio è una build precedente all'0.1.3 e va ricompilato.
 *
 * Resta un limite, e va detto: **ad app chiusa non arriva niente.**
 */

import type { PushPayload } from '@hive/shared';

/** Siamo dentro il guscio Mac? */
export function inDesktopShell(): boolean {
  return '__TAURI__' in window;
}

/** Il guscio sa mostrarle? Falso sulle build senza il plugin. */
export function nativeNotifyAvailable(): boolean {
  return inDesktopShell() && 'Notification' in window;
}

export async function nativeNotifyGranted(): Promise<boolean> {
  if (!nativeNotifyAvailable()) return false;
  return Notification.permission === 'granted';
}

export async function nativeNotifyEnable(): Promise<boolean> {
  if (!nativeNotifyAvailable()) return false;
  try {
    if (Notification.permission === 'granted') return true;
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Mostra la notifica arrivata sul filo.
 *
 * Se la finestra è davanti non si mostra niente: il messaggio è già sotto gli
 * occhi. macOS non nasconde le notifiche dell'app attiva — quel controllo
 * tocca a noi.
 */
export async function nativeNotifyShow(payload: PushPayload): Promise<void> {
  if (!nativeNotifyAvailable()) return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  if (!(await nativeNotifyGranted())) return;
  try {
    new Notification(payload.title, { body: payload.body, tag: payload.tag });
  } catch {
    // Permesso revocato mentre l'app era aperta: silenzio, non un crash.
  }
}
